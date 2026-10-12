/**
 * Read a portable skill directory out of a source-control repository and map
 * it onto managed-skill fields.
 *
 * Nothing here writes: an import always produces a reviewable result plus the
 * provenance needed to pin it, and the caller decides whether to store it.
 * Mapping is all-or-nothing — content that cannot become a valid managed skill
 * fails by name instead of arriving partially.
 */

import {
  isDeniedSkillFrontmatterKey,
  MAX_SKILL_FILES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FRONTMATTER_BYTES,
  MAX_SKILL_FRONTMATTER_DEPTH,
  MAX_SKILL_METADATA_KEY_LENGTH,
  MAX_SKILL_METADATA_VALUE_LENGTH,
  MAX_SKILL_REVISION_BYTES,
  skillContentInputSchema,
  skillFrontmatterBytes,
  skillFrontmatterDepth,
  skillFrontmatterKeyProblem,
  skillFileInputSchema,
  skillNameSchema,
  type SkillContentInput,
  type SkillFileInput,
  type SkillFrontmatterValue,
  type SkillImportSource,
  type SkillImportSourceInput,
  type SkillImportWarning,
} from "@open-inspect/shared/types/skills";
import type {
  RepositoryAccessResult,
  RepositoryReader,
  RepositoryTreeEntry,
} from "../source-control";
import { SourceControlProviderError } from "../source-control";
import { buildValidatedSkillRevision, hashImportedSourceTree } from "./content-addressing";
import {
  frontmatterNodeValue,
  parseSkillMarkdown,
  SkillMarkdownError,
  type ParsedSkillMarkdown,
  type SkillFrontmatterNode,
} from "./skill-markdown";

/** Blobs read concurrently. Bounded to keep one import's subrequest burst small. */
const BLOB_CONCURRENCY = 6;

/** Candidate skill directories named in a "no SKILL.md here" error. */
const MAX_SUGGESTED_DIRECTORIES = 20;

/**
 * Frontmatter keys that map onto managed-skill fields. Every other key is
 * preserved in `frontmatter`, or dropped with a warning when it is denied or
 * cannot be stored — never dropped without a trace.
 */
const MAPPED_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
]);

/** An import failure the caller can return verbatim; `status` is the HTTP status. */
export class SkillImportError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "SkillImportError";
  }
}

export interface SkillImportResult {
  name: string;
  content: SkillContentInput;
  source: SkillImportSource;
  warnings: SkillImportWarning[];
  revisionSha256: string;
  totalBytes: number;
  files: { path: string; content: string; sizeBytes: number; executable: boolean }[];
}

interface FetchedSourceFile {
  /** Path relative to the imported subdirectory. */
  path: string;
  content: string;
  executable: boolean;
}

/** Decode blob bytes as strict UTF-8, naming the file when they are not text. */
function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new SkillImportError(
      `${path} is not UTF-8 text; managed skills cannot contain binary files`,
      400
    );
  }
}

/** Normalize a subdirectory into the prefix its entries share (or ""). */
function directoryPrefix(subdirectory: string | null): string {
  return subdirectory ? `${subdirectory}/` : "";
}

/** Directories under `prefix` that hold their own SKILL.md, for error messages. */
function skillDirectoriesUnder(entries: RepositoryTreeEntry[], prefix: string): string[] {
  const directories = entries
    .filter(
      (entry) =>
        entry.type === "file" &&
        entry.path.startsWith(prefix) &&
        entry.path.endsWith("/SKILL.md") &&
        entry.path !== `${prefix}SKILL.md`
    )
    .map((entry) => entry.path.slice(0, -"/SKILL.md".length))
    .sort();
  return directories.length > MAX_SUGGESTED_DIRECTORIES
    ? [
        ...directories.slice(0, MAX_SUGGESTED_DIRECTORIES),
        `and ${directories.length - MAX_SUGGESTED_DIRECTORIES} more`,
      ]
    : directories;
}

/** Read blobs with bounded concurrency, preserving input order. */
async function readBlobs(
  provider: RepositoryReader,
  repository: { owner: string; name: string },
  entries: RepositoryTreeEntry[],
  prefix: string
): Promise<FetchedSourceFile[]> {
  const files = new Array<FetchedSourceFile>(entries.length);
  let next = 0;
  let totalBytes = 0;
  async function worker(): Promise<void> {
    for (let index = next++; index < entries.length; index = next++) {
      const entry = entries[index];
      const bytes = await provider.readBlob(
        {
          owner: repository.owner,
          name: repository.name,
          blobId: entry.blobId,
          maxBytes: MAX_SKILL_FILE_BYTES,
        },
        { kind: "all" }
      );
      const path = entry.path.slice(prefix.length);
      // The provider refuses an oversized blob before buffering when it can
      // tell the size up front. GitLab's tree carries no sizes, so this is the
      // check that actually holds for that provider.
      if (bytes.byteLength > MAX_SKILL_FILE_BYTES) {
        throw new SkillImportError(
          `${path} is ${bytes.byteLength} bytes, over the ${MAX_SKILL_FILE_BYTES}-byte per-file limit`,
          400
        );
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_SKILL_REVISION_BYTES) {
        throw new SkillImportError(
          `Imported content exceeds the ${MAX_SKILL_REVISION_BYTES}-byte skill limit`,
          400
        );
      }
      files[index] = {
        path,
        content: decodeUtf8(bytes, path),
        executable: entry.executable,
      };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(BLOB_CONCURRENCY, entries.length) }, () => worker())
  );
  return files;
}

/** Read one frontmatter entry as a bounded string, rejecting other shapes. */
function scalarField(frontmatter: ParsedSkillMarkdown["frontmatter"], key: string): string | null {
  const value = frontmatter.get(key);
  if (value === undefined) return null;
  if (value.kind !== "scalar") {
    throw new SkillImportError(`SKILL.md frontmatter "${key}" must be a single value`, 400);
  }
  return value.text;
}

function markdownValue(node: SkillFrontmatterNode, path: string): SkillFrontmatterValue {
  try {
    return frontmatterNodeValue(node, path);
  } catch (error) {
    if (error instanceof SkillMarkdownError) {
      throw new SkillImportError(`SKILL.md frontmatter is invalid: ${error.message}`, 400);
    }
    throw error;
  }
}

/**
 * Map `metadata` onto the flat string map managed skills store. Scalars keep
 * their written text; nested maps become dotted keys (`credits.author`) and
 * lists become JSON strings, each reported once as `flattened-metadata`.
 */
function flattenMetadata(
  node: SkillFrontmatterNode | undefined,
  warnings: SkillImportWarning[]
): Record<string, string> {
  if (node === undefined) return {};
  if (node.kind !== "map") {
    throw new SkillImportError('SKILL.md frontmatter "metadata" must be a map', 400);
  }
  const flat = new Map<string, string>();
  const flattened: string[] = [];
  function assign(key: string, value: string): void {
    if (flat.has(key)) {
      throw new SkillImportError(`SKILL.md metadata "${key}" is defined twice`, 400);
    }
    if (key.length === 0 || key.length > MAX_SKILL_METADATA_KEY_LENGTH) {
      throw new SkillImportError(
        `SKILL.md metadata key "${key}" must be 1 to ${MAX_SKILL_METADATA_KEY_LENGTH} characters`,
        400
      );
    }
    if (value.length > MAX_SKILL_METADATA_VALUE_LENGTH) {
      throw new SkillImportError(
        `SKILL.md metadata "${key}" is longer than ${MAX_SKILL_METADATA_VALUE_LENGTH} characters`,
        400
      );
    }
    flat.set(key, value);
  }
  function visit(entries: [string, SkillFrontmatterNode][], prefix: string, depth: number): void {
    for (const [key, child] of entries) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (child.kind === "map") {
        if (depth >= MAX_SKILL_FRONTMATTER_DEPTH) {
          throw new SkillImportError(
            `SKILL.md metadata "${path}" nests deeper than ${MAX_SKILL_FRONTMATTER_DEPTH} levels`,
            400
          );
        }
        visit(child.entries, path, depth + 1);
        continue;
      }
      assign(
        path,
        child.kind === "scalar"
          ? child.text
          : JSON.stringify(markdownValue(child, `metadata.${path}`))
      );
      if (prefix || child.kind === "sequence") flattened.push(path);
    }
  }
  visit(node.entries, "", 1);
  if (flattened.length > 0) {
    warnings.push({
      code: "flattened-metadata",
      message: `SKILL.md metadata nests maps or lists; stored as flat string keys ${flattened
        .map((key) => `"${key}"`)
        .join(", ")}`,
    });
  }
  return Object.fromEntries(flat);
}

/**
 * Keep every unmapped key that is allowed, as typed JSON. Denied keys and
 * values `frontmatter` cannot hold are dropped, each with a warning.
 */
function preserveFrontmatter(
  frontmatter: ParsedSkillMarkdown["frontmatter"],
  warnings: SkillImportWarning[]
): Record<string, SkillFrontmatterValue> {
  const preserved: [string, SkillFrontmatterValue][] = [];
  for (const [key, node] of frontmatter) {
    if (MAPPED_FRONTMATTER_KEYS.has(key)) continue;
    if (isDeniedSkillFrontmatterKey(key)) {
      warnings.push({
        code: "denied-frontmatter",
        message: `SKILL.md frontmatter "${key}" grants permissions or changes cost and was not imported`,
      });
      continue;
    }
    let problem = skillFrontmatterKeyProblem(key);
    let value: SkillFrontmatterValue | undefined;
    if (!problem) {
      try {
        value = frontmatterNodeValue(node, key);
        if (skillFrontmatterDepth(value) > MAX_SKILL_FRONTMATTER_DEPTH) {
          problem = `"${key}" nests deeper than ${MAX_SKILL_FRONTMATTER_DEPTH} levels`;
        }
      } catch (error) {
        if (!(error instanceof SkillMarkdownError)) throw error;
        problem = error.message;
      }
    }
    if (problem || value === undefined) {
      warnings.push({
        code: "unsupported-frontmatter",
        message: `SKILL.md frontmatter "${key}" was not imported: ${problem}`,
      });
      continue;
    }
    preserved.push([key, value]);
    warnings.push({
      code: "preserved-frontmatter",
      message: `SKILL.md frontmatter "${key}" was preserved as-is`,
    });
  }
  const result = Object.fromEntries(preserved);
  if (skillFrontmatterBytes(result) > MAX_SKILL_FRONTMATTER_BYTES) {
    throw new SkillImportError(
      `SKILL.md frontmatter beyond the mapped fields exceeds ${MAX_SKILL_FRONTMATTER_BYTES} bytes as JSON`,
      400
    );
  }
  return result;
}

/**
 * Map parsed frontmatter and body onto managed-skill content, collecting a
 * warning for every frontmatter key that was preserved, flattened or dropped.
 */
function mapFrontmatter(
  markdown: string,
  files: SkillFileInput[]
): { content: SkillContentInput; frontmatterName: string | null; warnings: SkillImportWarning[] } {
  let parsed: ParsedSkillMarkdown;
  try {
    parsed = parseSkillMarkdown(markdown);
  } catch (error) {
    if (error instanceof SkillMarkdownError) {
      throw new SkillImportError(`SKILL.md frontmatter is invalid: ${error.message}`, 400);
    }
    throw error;
  }
  const warnings: SkillImportWarning[] = [];
  const description = scalarField(parsed.frontmatter, "description");
  if (!description?.trim()) {
    throw new SkillImportError("SKILL.md frontmatter has no description", 400);
  }
  const metadata = flattenMetadata(parsed.frontmatter.get("metadata"), warnings);
  const frontmatter = preserveFrontmatter(parsed.frontmatter, warnings);
  const candidate = {
    description,
    body: parsed.body,
    license: scalarField(parsed.frontmatter, "license"),
    compatibility: scalarField(parsed.frontmatter, "compatibility"),
    metadata,
    frontmatter,
    files,
  };
  const content = skillContentInputSchema.safeParse(candidate);
  if (!content.success) {
    throw new SkillImportError(
      `Imported skill content is invalid: ${content.error.issues[0]?.message ?? "unknown error"}`,
      400
    );
  }
  return {
    content: content.data,
    frontmatterName: scalarField(parsed.frontmatter, "name"),
    warnings,
  };
}

/** Derive the canonical name, preferring an explicit override over the source. */
function resolveName(
  override: string | null | undefined,
  frontmatterName: string | null,
  subdirectory: string | null,
  repoName: string,
  warnings: SkillImportWarning[]
): string {
  if (override) {
    if (frontmatterName && frontmatterName !== override) {
      warnings.push({
        code: "name-overridden",
        message: `Stored as "${override}"; SKILL.md names this skill "${frontmatterName}"`,
      });
    }
    return override;
  }
  if (frontmatterName) {
    const parsed = skillNameSchema.safeParse(frontmatterName);
    if (!parsed.success) {
      throw new SkillImportError(
        `SKILL.md names this skill "${frontmatterName}", which is not a valid canonical name (lowercase letters, numbers, and single hyphens). Choose a name for the import.`,
        400
      );
    }
    return parsed.data;
  }
  const derived = (subdirectory?.split("/").pop() ?? repoName).toLowerCase();
  const parsed = skillNameSchema.safeParse(derived);
  if (!parsed.success) {
    throw new SkillImportError(
      "SKILL.md has no name and one cannot be derived from the source path. Choose a name for the import.",
      400
    );
  }
  warnings.push({
    code: "name-derived",
    message: `SKILL.md has no name; "${parsed.data}" was derived from the source path`,
  });
  return parsed.data;
}

/** Resolve source access with the importer's HTTP error semantics, before reading content. */
export async function resolveSkillImportRepository(
  provider: RepositoryReader,
  source: SkillImportSourceInput
): Promise<RepositoryAccessResult> {
  const requestedRepository = {
    owner: source.repository.repoOwner,
    name: source.repository.repoName,
  };
  const label = `${requestedRepository.owner}/${requestedRepository.name}`;
  let access: Awaited<ReturnType<RepositoryReader["checkRepositoryAccess"]>>;
  try {
    access = await provider.checkRepositoryAccess(requestedRepository);
  } catch (error) {
    throw providerFailure(error, `Failed to reach ${label}`);
  }
  if (!access) {
    throw new SkillImportError(
      `${label} is not accessible to this installation. Grant the app access to the repository and try again.`,
      404
    );
  }
  return access;
}

/**
 * Fetch, map, and validate one skill directory at a resolved commit.
 *
 * @param nameOverride - Canonical name to store under, overriding the source.
 * @param resolvedRepository - Reuse the SCM identity already authorized by the route.
 * @throws SkillImportError with the status the caller should return.
 */
export async function fetchSkillImport(
  provider: RepositoryReader,
  source: SkillImportSourceInput,
  nameOverride?: string | null,
  resolvedRepository?: RepositoryAccessResult
): Promise<SkillImportResult> {
  const label = `${source.repository.repoOwner}/${source.repository.repoName}`;
  const access = resolvedRepository ?? (await resolveSkillImportRepository(provider, source));
  const repository = { owner: access.repoOwner, name: access.repoName };
  const requestedRef = source.ref ?? null;
  const resolvedRef = requestedRef ?? access.defaultBranch;
  let commit: Awaited<ReturnType<RepositoryReader["resolveCommit"]>>;
  try {
    commit = await provider.resolveCommit({ ...repository, ref: resolvedRef }, { kind: "all" });
  } catch (error) {
    throw providerFailure(error, `Failed to resolve ${resolvedRef} in ${label}`);
  }
  if (!commit) {
    throw new SkillImportError(`${label} has no branch, tag, or commit "${resolvedRef}"`, 404);
  }

  let tree: Awaited<ReturnType<RepositoryReader["listTree"]>>;
  try {
    tree = await provider.listTree(
      {
        ...repository,
        commitSha: commit.sha,
        path: source.subdirectory,
      },
      { kind: "all" }
    );
  } catch (error) {
    throw providerFailure(error, `Failed to list ${label} at ${commit.sha}`);
  }
  if (tree.truncated) {
    throw new SkillImportError(
      `${label} is too large to list completely; import from a repository with fewer files`,
      400
    );
  }

  const prefix = directoryPrefix(source.subdirectory ?? null);
  const location = source.subdirectory ? `${label}/${source.subdirectory}` : label;
  const scoped = tree.entries.filter((entry) => entry.path.startsWith(prefix));
  const skillMarkdownEntry = scoped.find(
    (entry) => entry.path === `${prefix}SKILL.md` && entry.type === "file"
  );
  if (!skillMarkdownEntry) {
    const candidates = skillDirectoriesUnder(tree.entries, prefix);
    throw new SkillImportError(
      candidates.length > 0
        ? `No SKILL.md in ${location}. Skills found in: ${candidates.join(", ")}`
        : `No SKILL.md in ${location}`,
      404
    );
  }

  const supporting = scoped.filter((entry) => entry.path !== skillMarkdownEntry.path);
  const unsupported = supporting.find((entry) => entry.type === "other");
  if (unsupported) {
    throw new SkillImportError(
      `${unsupported.path.slice(prefix.length)} is a symlink or submodule, which managed skills cannot store`,
      400
    );
  }
  const blobs = supporting.filter((entry) => entry.type === "file");
  if (blobs.length + 1 > MAX_SKILL_FILES) {
    throw new SkillImportError(
      `${location} has ${blobs.length + 1} files, over the ${MAX_SKILL_FILES}-file limit`,
      400
    );
  }
  // Providers that report sizes let an oversized import fail before a single
  // blob is fetched. Providers that do not report a null size, which sums to
  // nothing here and leaves the post-read checks in readBlobs to catch it.
  const declaredBytes = [skillMarkdownEntry, ...blobs].reduce(
    (total, entry) => total + (entry.sizeBytes ?? 0),
    0
  );
  if (declaredBytes > MAX_SKILL_REVISION_BYTES) {
    throw new SkillImportError(
      `Imported content exceeds the ${MAX_SKILL_REVISION_BYTES}-byte skill limit`,
      400
    );
  }

  let fetched: FetchedSourceFile[];
  try {
    fetched = await readBlobs(provider, repository, [skillMarkdownEntry, ...blobs], prefix);
  } catch (error) {
    if (error instanceof SkillImportError) throw error;
    throw providerFailure(error, `Failed to read ${location} at ${commit.sha}`);
  }
  const [markdownFile, ...supportingFiles] = fetched;

  const files: SkillFileInput[] = [];
  for (const file of supportingFiles) {
    const parsed = skillFileInputSchema.safeParse(file);
    if (!parsed.success) {
      throw new SkillImportError(
        `${file.path} cannot be imported: ${parsed.error.issues[0]?.message ?? "invalid file"}`,
        400
      );
    }
    files.push(parsed.data);
  }

  const mapped = mapFrontmatter(markdownFile.content, files);
  const warnings = [...mapped.warnings];
  const name = resolveName(
    nameOverride,
    mapped.frontmatterName,
    source.subdirectory ?? null,
    source.repository.repoName,
    warnings
  );
  const revision = await buildValidatedSkillRevision(name, mapped.content);
  return {
    name,
    content: mapped.content,
    warnings,
    revisionSha256: revision.revisionSha256,
    totalBytes: revision.totalBytes,
    files: revision.files.map((file) => ({
      path: file.path,
      content: file.content,
      sizeBytes: file.sizeBytes,
      executable: file.executable,
    })),
    source: {
      provider: provider.name,
      // The provider's own view of the identity, not the request's. A caller
      // may name a different case or a partial namespace; re-import replays
      // exactly what is stored here, so it has to be what the provider
      // resolves to rather than what someone typed.
      repoOwner: access.repoOwner,
      repoName: access.repoName,
      requestedRef,
      resolvedRef,
      commitSha: commit.sha,
      subdirectory: source.subdirectory ?? null,
      sourceSha256: await hashImportedSourceTree(fetched),
    },
  };
}

/** Present an upstream failure as an import failure without leaking retry semantics. */
function providerFailure(error: unknown, message: string): SkillImportError {
  if (error instanceof SourceControlProviderError) {
    const status = error.httpStatus === 413 ? 400 : error.errorType === "transient" ? 503 : 502;
    return new SkillImportError(`${message}: ${error.message}`, status);
  }
  return new SkillImportError(
    `${message}: ${error instanceof Error ? error.message : String(error)}`,
    502
  );
}
