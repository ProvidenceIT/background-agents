/**
 * Where the `prompt-library` service may import managed skills from.
 *
 * The service runs the unattended prompt-library sync for one signed-in
 * person, so on top of that person's own `skills.manage` grant it is pinned
 * to reviewed content: it imports only from the repositories in
 * `PROMPT_LIBRARY_SKILL_REPOSITORIES`, only at a full commit SHA, and touches
 * only skills recorded as imported from one of those repositories. People and
 * every other principal are not affected: each check returns null for them.
 */

import type { SkillImportProvenance } from "@open-inspect/shared/types/skills";
import type { RequestContext } from "../http/request-context";
import { json } from "../http/responses";

/** Repositories the service may import from when `PROMPT_LIBRARY_SKILL_REPOSITORIES` is unset. */
export const DEFAULT_PROMPT_LIBRARY_SKILL_REPOSITORIES = "ProvidenceIT/prompt-library";

const COMMIT_SHA = /^[0-9a-f]{40}$/;

export const PROMPT_LIBRARY_SOURCE_NOT_ALLOWED = "prompt_library_source_not_allowed";
export const PROMPT_LIBRARY_REF_NOT_PINNED = "prompt_library_ref_not_pinned";

interface RepositoryIdentity {
  repoOwner: string;
  repoName: string;
}

/** Whether the request is the prompt-library service acting for someone. */
export function isPromptLibraryService(ctx: RequestContext): boolean {
  return ctx.principal?.kind === "service" && ctx.principal.service === "prompt-library";
}

/**
 * The allowlist as lower-cased `owner/name` keys: comma-separated, blanks
 * ignored, and the default when the variable is unset or holds no entry.
 */
export function promptLibrarySkillRepositories(value: string | undefined): ReadonlySet<string> {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return new Set(
    entries.length > 0 ? entries : [DEFAULT_PROMPT_LIBRARY_SKILL_REPOSITORIES.toLowerCase()]
  );
}

function refused(message: string, code: string): Response {
  return json({ error: message, code }, 403);
}

function repositoryRefusal(
  allowlist: string | undefined,
  repository: RepositoryIdentity | null
): Response | null {
  const key = repository ? `${repository.repoOwner}/${repository.repoName}`.toLowerCase() : null;
  if (key && promptLibrarySkillRepositories(allowlist).has(key)) return null;
  return refused(
    repository
      ? `The prompt-library service may not manage skills from ${repository.repoOwner}/${repository.repoName}`
      : "The prompt-library service may only manage skills imported from its repositories",
    PROMPT_LIBRARY_SOURCE_NOT_ALLOWED
  );
}

function refRefusal(ref: string | null | undefined): Response | null {
  if (ref && COMMIT_SHA.test(ref)) return null;
  return refused(
    "The prompt-library service must name a full 40-character commit SHA as the ref",
    PROMPT_LIBRARY_REF_NOT_PINNED
  );
}

/** Import preview and import: the named repository is allowlisted and `ref` is a commit SHA. */
export function promptLibraryImportRefusal(
  ctx: RequestContext,
  allowlist: string | undefined,
  source: { repository: RepositoryIdentity; ref?: string | null }
): Response | null {
  if (!isPromptLibraryService(ctx)) return null;
  return repositoryRefusal(allowlist, source.repository) ?? refRefusal(source.ref);
}

/** Re-import preview and re-import: the skill's recorded repository is allowlisted and `ref` is a commit SHA. */
export function promptLibraryReimportRefusal(
  ctx: RequestContext,
  allowlist: string | undefined,
  recorded: SkillImportProvenance | null,
  ref: string | null | undefined
): Response | null {
  if (!isPromptLibraryService(ctx)) return null;
  return repositoryRefusal(allowlist, recorded) ?? refRefusal(ref);
}

/** Enable or disable: the skill was recorded as imported from an allowlisted repository. */
export function promptLibraryUpdateRefusal(
  ctx: RequestContext,
  allowlist: string | undefined,
  recorded: SkillImportProvenance | null
): Response | null {
  if (!isPromptLibraryService(ctx)) return null;
  return repositoryRefusal(allowlist, recorded);
}

/**
 * After the read: the commit actually read is the one the ref named, so a
 * branch or tag that happens to look like a SHA cannot stand in for it.
 */
export function promptLibraryResolvedCommitRefusal(
  ctx: RequestContext,
  ref: string | null | undefined,
  commitSha: string
): Response | null {
  if (!isPromptLibraryService(ctx) || ref === commitSha) return null;
  return refused(
    `The ref resolved to commit ${commitSha}, not to the commit it names`,
    PROMPT_LIBRARY_REF_NOT_PINNED
  );
}
