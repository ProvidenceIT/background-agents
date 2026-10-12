import { describe, expect, it, vi } from "vitest";
import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FRONTMATTER_BYTES,
  MAX_SKILL_REVISION_BYTES,
  skillImportSourceInputSchema,
} from "@open-inspect/shared/types/skills";
import type { GetRepositoryConfig, RepositoryReader, RepositoryTree } from "../source-control";
import { SourceControlProviderError } from "../source-control";
import { fetchSkillImport, SkillImportError } from "./git-import";

const COMMIT = "a".repeat(40);

interface FakeFile {
  content: string | Uint8Array;
  executable?: boolean;
}

/**
 * Minimal repository stand-in. Only the four methods an import calls are
 * implemented; anything else reaching this double is a bug in the importer.
 */
function fakeProvider(
  files: Record<string, FakeFile>,
  overrides: {
    accessible?: boolean;
    commit?: string | null;
    truncated?: boolean;
    defaultBranch?: string;
    otherEntries?: string[];
    /** Mimic GitLab, whose tree listing reports no blob sizes. */
    sizelessTree?: boolean;
    normalizedIdentity?: { repoOwner: string; repoName: string };
    blobLimits?: number[];
    listedPaths?: (string | null | undefined)[];
  } = {}
): RepositoryReader {
  const encoder = new TextEncoder();
  const blobs = new Map<string, Uint8Array>();
  const entries: RepositoryTree["entries"] = [];
  for (const [path, file] of Object.entries(files)) {
    const blobId = `blob-${path}`;
    const bytes = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
    blobs.set(blobId, bytes);
    entries.push({
      path,
      type: "file",
      blobId,
      sizeBytes: overrides.sizelessTree ? null : bytes.byteLength,
      executable: file.executable ?? false,
    });
  }
  for (const path of overrides.otherEntries ?? []) {
    entries.push({
      path,
      type: "other",
      blobId: `other-${path}`,
      sizeBytes: null,
      executable: false,
    });
  }
  const importSurface: RepositoryReader = {
    name: "github",
    checkRepositoryAccess: async (config: GetRepositoryConfig) =>
      overrides.accessible === false
        ? null
        : {
            repoId: 1,
            repoOwner: overrides.normalizedIdentity?.repoOwner ?? config.owner,
            repoName: overrides.normalizedIdentity?.repoName ?? config.name,
            defaultBranch: overrides.defaultBranch ?? "main",
          },
    resolveCommit: async () =>
      overrides.commit === null ? null : { sha: overrides.commit ?? COMMIT },
    listTree: async ({ path }) => {
      overrides.listedPaths?.push(path);
      return { entries, truncated: overrides.truncated ?? false };
    },
    readBlob: async ({ blobId, maxBytes }) => {
      overrides.blobLimits?.push(maxBytes);
      const bytes = blobs.get(blobId);
      if (!bytes) throw new Error(`missing blob ${blobId}`);
      return bytes;
    },
  };
  return importSurface;
}

function source(input: { subdirectory?: string; ref?: string } = {}) {
  return skillImportSourceInputSchema.parse({
    repository: { repoOwner: "Acme", repoName: "Skills" },
    ...input,
  });
}

const SKILL_MD = [
  "---",
  "name: deploy-service",
  "description: Deploys the API",
  "---",
  "# Deploy",
  "",
].join("\n");

describe("fetchSkillImport", () => {
  it("imports the workspace catalog with installation-wide content access", async () => {
    const provider = fakeProvider({ "SKILL.md": { content: SKILL_MD } });
    const resolveCommit = vi.spyOn(provider, "resolveCommit");
    const listTree = vi.spyOn(provider, "listTree");
    const readBlob = vi.spyOn(provider, "readBlob");
    await fetchSkillImport(provider, source());
    for (const method of [resolveCommit, listTree, readBlob]) {
      expect(method).toHaveBeenCalledWith(expect.any(Object), { kind: "all" });
    }
  });

  it("reuses the repository resolution already authorized by the route", async () => {
    const provider = fakeProvider({ "SKILL.md": { content: SKILL_MD } });
    const check = vi.spyOn(provider, "checkRepositoryAccess");
    const resolveCommit = vi.spyOn(provider, "resolveCommit");
    const result = await fetchSkillImport(provider, source(), undefined, {
      repoId: 123,
      repoOwner: "canonical-owner",
      repoName: "canonical-name",
      defaultBranch: "develop",
    });
    expect(check).not.toHaveBeenCalled();
    expect(resolveCommit).toHaveBeenCalledWith(
      {
        owner: "canonical-owner",
        name: "canonical-name",
        ref: "develop",
      },
      { kind: "all" }
    );
    expect(result.source).toMatchObject({
      repoOwner: "canonical-owner",
      repoName: "canonical-name",
      resolvedRef: "develop",
    });
  });

  it("maps SKILL.md and supporting files onto a validated revision", async () => {
    const provider = fakeProvider({
      "SKILL.md": { content: SKILL_MD },
      "scripts/deploy.sh": { content: "#!/bin/sh\n", executable: true },
      "references/runbook.md": { content: "steps\n" },
    });

    const result = await fetchSkillImport(provider, source());

    expect(result.name).toBe("deploy-service");
    expect(result.content.description).toBe("Deploys the API");
    expect(result.content.body).toBe("# Deploy\n");
    expect(result.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/runbook.md",
      "scripts/deploy.sh",
    ]);
    expect(result.files.find((file) => file.path === "scripts/deploy.sh")?.executable).toBe(true);
    expect(result.files.find((file) => file.path === "scripts/deploy.sh")?.content).toBe(
      "#!/bin/sh\n"
    );
    expect(result.warnings).toEqual([]);
    expect(result.source).toMatchObject({
      provider: "github",
      repoOwner: "acme",
      repoName: "skills",
      requestedRef: null,
      resolvedRef: "main",
      commitSha: COMMIT,
      subdirectory: null,
    });
  });

  it("distinguishes the source digest from the stored revision digest", async () => {
    const provider = fakeProvider({ "SKILL.md": { content: SKILL_MD } });

    const result = await fetchSkillImport(provider, source());

    expect(result.source.sourceSha256).not.toBe(result.revisionSha256);
    const storedMarkdown = result.files.find((file) => file.path === "SKILL.md")?.content;
    expect(storedMarkdown).not.toBe(SKILL_MD);
    expect(storedMarkdown).toContain("name: deploy-service");
  });

  it("reads a skill from a subdirectory and strips the prefix from paths", async () => {
    const listedPaths: (string | null | undefined)[] = [];
    const provider = fakeProvider(
      {
        "README.md": { content: "repo readme\n" },
        "skills/deploy-service/SKILL.md": { content: SKILL_MD },
        "skills/deploy-service/references/runbook.md": { content: "steps\n" },
      },
      { listedPaths }
    );

    const result = await fetchSkillImport(
      provider,
      source({ subdirectory: "skills/deploy-service" })
    );

    expect(result.files.map((file) => file.path)).toEqual(["SKILL.md", "references/runbook.md"]);
    expect(result.source.subdirectory).toBe("skills/deploy-service");
    expect(listedPaths).toEqual(["skills/deploy-service"]);
  });

  it("names the skill directories it found when the target has no SKILL.md", async () => {
    const provider = fakeProvider({
      "skills/deploy-service/SKILL.md": { content: SKILL_MD },
      "skills/review/SKILL.md": { content: SKILL_MD },
    });

    await expect(fetchSkillImport(provider, source())).rejects.toThrow(
      /No SKILL\.md in acme\/skills\. Skills found in: skills\/deploy-service, skills\/review/
    );
  });

  it("prefers an explicit name and reports the override", async () => {
    const provider = fakeProvider({ "SKILL.md": { content: SKILL_MD } });

    const result = await fetchSkillImport(provider, source(), "acme-deploy");

    expect(result.name).toBe("acme-deploy");
    expect(result.warnings).toEqual([
      {
        code: "name-overridden",
        message: 'Stored as "acme-deploy"; SKILL.md names this skill "deploy-service"',
      },
    ]);
  });

  it("derives a name from the source path when the frontmatter has none", async () => {
    const provider = fakeProvider({
      "skills/deploy-service/SKILL.md": {
        content: "---\ndescription: Deploys the API\n---\n# Deploy\n",
      },
    });

    const result = await fetchSkillImport(
      provider,
      source({ subdirectory: "skills/deploy-service" })
    );

    expect(result.name).toBe("deploy-service");
    expect(result.warnings).toEqual([
      {
        code: "name-derived",
        message: 'SKILL.md has no name; "deploy-service" was derived from the source path',
      },
    ]);
  });

  it("derives an unnamed skill from the requested alias while reading the canonical repository", async () => {
    const provider = fakeProvider(
      { "SKILL.md": { content: "---\ndescription: Deploys the API\n---\n# Deploy\n" } },
      { normalizedIdentity: { repoOwner: "canonical-owner", repoName: "renamed-skills" } }
    );
    const resolveCommit = vi.spyOn(provider, "resolveCommit");
    const listTree = vi.spyOn(provider, "listTree");
    const readBlob = vi.spyOn(provider, "readBlob");

    const result = await fetchSkillImport(provider, source());

    expect(result.name).toBe("skills");
    expect(result.source).toMatchObject({
      repoOwner: "canonical-owner",
      repoName: "renamed-skills",
    });
    for (const read of [resolveCommit, listTree, readBlob]) {
      expect(read).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "canonical-owner", name: "renamed-skills" }),
        { kind: "all" }
      );
    }
  });

  it("preserves host frontmatter with its YAML types and reports each key", async () => {
    const provider = fakeProvider({
      "SKILL.md": {
        content: [
          "---",
          "name: deploy-service",
          "description: Deploys",
          "disable-model-invocation: true",
          'argument-hint: "[environment]"',
          "paths:",
          "  - deploy/**",
          "mode: ~",
          "priority: 2",
          "icon: 🚀",
          "---",
          "body",
          "",
        ].join("\n"),
      },
    });

    const result = await fetchSkillImport(provider, source());

    expect(result.content.frontmatter).toEqual({
      "disable-model-invocation": true,
      "argument-hint": "[environment]",
      paths: ["deploy/**"],
      mode: null,
      priority: 2,
      icon: "🚀",
    });
    expect(result.warnings.map((warning) => [warning.code, warning.message])).toEqual(
      ["disable-model-invocation", "argument-hint", "paths", "mode", "priority", "icon"].map(
        (key) => ["preserved-frontmatter", `SKILL.md frontmatter "${key}" was preserved as-is`]
      )
    );
    const markdown = result.files.find((file) => file.path === "SKILL.md")!.content;
    expect(markdown).toContain("\ndisable-model-invocation: true\n");
    expect(markdown.split("\n")[1]).toBe("name: deploy-service");
  });

  it("drops frontmatter that grants permissions or changes cost", async () => {
    const provider = fakeProvider({
      "SKILL.md": {
        content: [
          "---",
          "name: deploy-service",
          "description: Deploys",
          "allowed-tools: [Bash, Read]",
          "model: opus",
          "effort: high",
          "hooks:",
          "  PreToolUse: []",
          "user-invocable: false",
          "---",
          "body",
          "",
        ].join("\n"),
      },
    });

    const result = await fetchSkillImport(provider, source());

    expect(result.content.frontmatter).toEqual({ "user-invocable": false });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "denied-frontmatter",
      "denied-frontmatter",
      "denied-frontmatter",
      "denied-frontmatter",
      "preserved-frontmatter",
    ]);
    expect(result.warnings[0].message).toContain('"allowed-tools" grants permissions');
    const markdown = result.files.find((file) => file.path === "SKILL.md")!.content;
    expect(markdown).not.toMatch(/allowed-tools|model:|hooks|effort/);
  });

  it("drops keys and values preserved frontmatter cannot hold", async () => {
    const provider = fakeProvider({
      "SKILL.md": {
        content: [
          "---",
          "name: deploy-service",
          "description: Deploys",
          "Name: shadow",
          "2fa: required",
          "ratio: .inf",
          "deep: [[[[[1]]]]]",
          "kept: [[[[1]]]]",
          "---",
          "body",
          "",
        ].join("\n"),
      },
    });

    const result = await fetchSkillImport(provider, source());

    expect(result.content.frontmatter).toEqual({ kept: [[[[1]]]] });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "unsupported-frontmatter",
      "unsupported-frontmatter",
      "unsupported-frontmatter",
      "unsupported-frontmatter",
      "preserved-frontmatter",
    ]);
    expect(result.warnings[2].message).toContain("finite number");
    expect(result.warnings[3].message).toContain("nests deeper");
  });

  it("rejects preserved frontmatter over the size limit", async () => {
    const provider = fakeProvider({
      "SKILL.md": {
        content: `---\nname: deploy-service\ndescription: Deploys\nreminder: ${"x".repeat(
          MAX_SKILL_FRONTMATTER_BYTES
        )}\n---\nbody\n`,
      },
    });

    await expect(fetchSkillImport(provider, source())).rejects.toThrow(
      /frontmatter beyond the mapped fields exceeds/
    );
  });

  it.each([
    ["an alias", "anchor: &a x\nalias: *a", /anchors are not supported/],
    ["a custom tag", "flag: !!bool true", /tags are not supported/],
    ["a duplicate key", "mode: a\nmode: b", /SKILL\.md frontmatter is invalid/],
    ["keys equal as text", '1: a\n"1": b', /duplicate key/],
  ])("rejects %s anywhere in the frontmatter", async (_case, extra, message) => {
    const provider = fakeProvider({
      "SKILL.md": { content: `---\nname: deploy-service\ndescription: d\n${extra}\n---\n` },
    });

    await expect(fetchSkillImport(provider, source())).rejects.toThrow(message);
  });

  it("flattens nested metadata to dotted string keys", async () => {
    const provider = fakeProvider({
      "SKILL.md": {
        content: [
          "---",
          "name: pr",
          "description: Opens pull requests",
          "metadata:",
          "  version: 1.0",
          "  credits:",
          "    skill: pr",
          "    author: Matt Pocock",
          "    organisation: AI Hero",
          "    url: https://example.com/pr",
          "  tags: [git, github]",
          "---",
          "body",
          "",
        ].join("\n"),
      },
    });

    const result = await fetchSkillImport(provider, source());

    expect(result.content.metadata).toEqual({
      version: "1.0",
      "credits.skill": "pr",
      "credits.author": "Matt Pocock",
      "credits.organisation": "AI Hero",
      "credits.url": "https://example.com/pr",
      tags: '["git","github"]',
    });
    expect(result.warnings).toEqual([
      {
        code: "flattened-metadata",
        message:
          'SKILL.md metadata nests maps or lists; stored as flat string keys "credits.skill", "credits.author", "credits.organisation", "credits.url", "tags"',
      },
    ]);
  });

  it.each([
    ["a flattened key collision", "  a.b: x\n  a:\n    b: y", /"a\.b" is defined twice/],
    ["an over-long key", `  ${"k".repeat(101)}: x`, /must be 1 to 100 characters/],
    ["an over-long value", `  k: ${"v".repeat(501)}`, /longer than 500 characters/],
    ["a scalar", "", /"metadata" must be a map/],
  ])("rejects metadata with %s", async (_case, entries, message) => {
    const metadata = entries ? `metadata:\n${entries}` : "metadata: flat";
    const provider = fakeProvider({
      "SKILL.md": { content: `---\nname: deploy-service\ndescription: d\n${metadata}\n---\n` },
    });

    await expect(fetchSkillImport(provider, source())).rejects.toThrow(message);
  });

  it("imports the same source to the same revision digest", async () => {
    const markdown =
      "---\nname: pr\ndescription: d\ndisable-model-invocation: true\nreminder: {b: 1, a: 2}\n---\nbody\n";
    const first = await fetchSkillImport(
      fakeProvider({ "SKILL.md": { content: markdown } }),
      source()
    );
    const second = await fetchSkillImport(
      fakeProvider({ "SKILL.md": { content: markdown.replace("{b: 1, a: 2}", "{a: 2, b: 1}") } }),
      source()
    );

    expect(second.revisionSha256).toBe(first.revisionSha256);
  });

  it("carries license, compatibility, and metadata across", async () => {
    const provider = fakeProvider({
      "SKILL.md": {
        content: [
          "---",
          "name: deploy-service",
          "description: Deploys",
          "license: Apache-2.0",
          "compatibility: Requires kubectl",
          "metadata:",
          "  team owner: platform",
          "---",
          "body",
          "",
        ].join("\n"),
      },
    });

    const result = await fetchSkillImport(provider, source());

    expect(result.content.license).toBe("Apache-2.0");
    expect(result.content.compatibility).toBe("Requires kubectl");
    expect(result.content.metadata).toEqual({ "team owner": "platform" });
  });

  it.each([
    [
      "an inaccessible repository",
      () => fakeProvider({}, { accessible: false }),
      /not accessible to this installation/,
      404,
    ],
    [
      "a missing ref",
      () => fakeProvider({ "SKILL.md": { content: SKILL_MD } }, { commit: null }),
      /has no branch, tag, or commit "main"/,
      404,
    ],
    [
      "a truncated listing",
      () => fakeProvider({ "SKILL.md": { content: SKILL_MD } }, { truncated: true }),
      /too large to list completely/,
      400,
    ],
    [
      "a binary supporting file",
      () =>
        fakeProvider({
          "SKILL.md": { content: SKILL_MD },
          "assets/logo.png": { content: Uint8Array.of(0x89, 0x50, 0x4e, 0xff, 0xfe) },
        }),
      /assets\/logo\.png is not UTF-8 text/,
      400,
    ],
    [
      "an executable outside scripts/",
      () =>
        fakeProvider({
          "SKILL.md": { content: SKILL_MD },
          "bin/tool.sh": { content: "#!/bin/sh\n", executable: true },
        }),
      /bin\/tool\.sh cannot be imported/,
      400,
    ],
    [
      "a symlink",
      () =>
        fakeProvider({ "SKILL.md": { content: SKILL_MD } }, { otherEntries: ["references/link"] }),
      /references\/link is a symlink or submodule/,
      400,
    ],
    [
      "frontmatter without a description",
      () => fakeProvider({ "SKILL.md": { content: "---\nname: deploy-service\n---\nbody\n" } }),
      /has no description/,
      400,
    ],
    [
      "unreadable frontmatter",
      () => fakeProvider({ "SKILL.md": { content: "# Deploy\n" } }),
      /SKILL\.md frontmatter is invalid/,
      400,
    ],
    [
      "a name that is not a canonical name",
      () =>
        fakeProvider({
          "SKILL.md": { content: "---\nname: Deploy Service\ndescription: d\n---\n" },
        }),
      /is not a valid canonical name/,
      400,
    ],
  ])("rejects %s", async (_case, build, message, status) => {
    const error = await fetchSkillImport(build(), source()).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SkillImportError);
    expect((error as SkillImportError).message).toMatch(message);
    expect((error as SkillImportError).status).toBe(status);
  });

  it("records the provider's normalized repository identity, not the request's", async () => {
    const provider = fakeProvider(
      { "SKILL.md": { content: SKILL_MD } },
      { normalizedIdentity: { repoOwner: "acme-group/platform", repoName: "skills" } }
    );

    const result = await fetchSkillImport(provider, source());

    expect(result.source.repoOwner).toBe("acme-group/platform");
    expect(result.source.repoName).toBe("skills");
  });

  it("tells the provider the per-file limit so it can refuse before buffering", async () => {
    const blobLimits: number[] = [];
    const provider = fakeProvider({ "SKILL.md": { content: SKILL_MD } }, { blobLimits });

    await fetchSkillImport(provider, source());

    expect(blobLimits).toEqual([MAX_SKILL_FILE_BYTES]);
  });

  it("reports an upstream blob-limit rejection as an import validation error", async () => {
    const provider = fakeProvider({ "SKILL.md": { content: SKILL_MD } });
    provider.readBlob = async () => {
      throw new SourceControlProviderError("Blob is over the limit", "permanent", 413);
    };

    const error = await fetchSkillImport(provider, source()).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SkillImportError);
    expect((error as SkillImportError).status).toBe(400);
  });

  it("enforces the revision limit on a tree that reports no sizes", async () => {
    const half = "x".repeat(200 * 1024);
    const provider = fakeProvider(
      {
        "SKILL.md": { content: SKILL_MD },
        "references/a.md": { content: half },
        "references/b.md": { content: half },
        "references/c.md": { content: half },
        "references/d.md": { content: half },
        "references/e.md": { content: half },
        "references/f.md": { content: half },
      },
      { sizelessTree: true }
    );

    await expect(fetchSkillImport(provider, source())).rejects.toThrow(
      new RegExp(`Imported content exceeds the ${MAX_SKILL_REVISION_BYTES}-byte skill limit`)
    );
  });

  it("rejects an oversized SKILL.md from the declared sizes alone", async () => {
    const blobLimits: number[] = [];
    const provider = fakeProvider(
      { "SKILL.md": { content: `${SKILL_MD}${"x".repeat(MAX_SKILL_REVISION_BYTES)}` } },
      { blobLimits }
    );

    await expect(fetchSkillImport(provider, source())).rejects.toThrow(
      new RegExp(`exceeds the ${MAX_SKILL_REVISION_BYTES}-byte skill limit`)
    );
    expect(blobLimits).toEqual([]);
  });

  it("rejects a file over the per-file size limit", async () => {
    const provider = fakeProvider({
      "SKILL.md": { content: SKILL_MD },
      "references/big.md": { content: "x".repeat(MAX_SKILL_FILE_BYTES + 1) },
    });

    await expect(fetchSkillImport(provider, source())).rejects.toThrow(
      new RegExp(
        `references/big\\.md is ${MAX_SKILL_FILE_BYTES + 1} bytes, ` +
          `over the ${MAX_SKILL_FILE_BYTES}-byte per-file limit`
      )
    );
  });
});
