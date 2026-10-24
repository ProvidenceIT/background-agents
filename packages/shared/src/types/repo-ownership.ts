/**
 * Repository ownership: which team owns a repository, how critical it is
 * (tier) and what kind of repository it is (class), plus the owners its
 * CODEOWNERS file names. Stored on `repo_metadata` (migration 0104).
 *
 * `repoClass` is nullable on purpose: an unclassified repository is treated as
 * `client` by every consumer ({@link effectiveRepoClass}), so a policy keyed on
 * class (auto-merge is for internal and playground only) fails closed.
 */
import { z } from "zod";
import { parseRepositoryFullName } from "./repositories";

export const REPO_TIERS = ["T1", "T2", "T3"] as const;
export const repoTierSchema = z.enum(REPO_TIERS);
export type RepoTier = z.infer<typeof repoTierSchema>;

export const REPO_CLASSES = ["playground", "internal", "client"] as const;
export const repoClassSchema = z.enum(REPO_CLASSES);
export type RepoClass = z.infer<typeof repoClassSchema>;

/** The class every consumer applies: an unclassified repository is a client repository. */
export function effectiveRepoClass(repoClass: RepoClass | null | undefined): RepoClass {
  return repoClass ?? "client";
}

export const REPO_DOMAIN_MAX_CHARS = 100;
export const REPO_DEPENDS_ON_MAX = 50;

// ---------------------------------------------------------------------------
// CODEOWNERS
// ---------------------------------------------------------------------------

export const CODEOWNERS_OWNER_KINDS = ["user", "team", "email"] as const;
export const codeownersOwnerSchema = z.object({
  kind: z.enum(CODEOWNERS_OWNER_KINDS),
  /** As written in the file: `@login`, `@org/team-slug` or an email address. */
  handle: z.string().min(1),
});
export type CodeownersOwner = z.infer<typeof codeownersOwnerSchema>;

export const codeownersRuleSchema = z.object({
  pattern: z.string().min(1),
  /** Empty when the rule leaves its paths without an owner. */
  owners: z.array(codeownersOwnerSchema),
});
export type CodeownersRule = z.infer<typeof codeownersRuleSchema>;

const USER_HANDLE = /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const TEAM_HANDLE = /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseOwner(token: string): CodeownersOwner | null {
  if (TEAM_HANDLE.test(token)) return { kind: "team", handle: token };
  if (USER_HANDLE.test(token)) return { kind: "user", handle: token };
  if (EMAIL.test(token)) return { kind: "email", handle: token };
  return null;
}

/**
 * Parse a CODEOWNERS file into its rules, in file order (on GitHub the last
 * matching rule wins). Follows GitHub's syntax: `#` starts a comment unless
 * escaped as `\#`; a line GitHub would reject (a `!` negation, a `[ ]` range,
 * or an owner that is not `@user`, `@org/team` or an email) is skipped whole,
 * as GitHub skips it.
 */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const tokens: string[] = [];
    for (const token of line.trim().split(/\s+/)) {
      if (token === "") continue;
      if (token.startsWith("#")) break;
      tokens.push(token);
    }
    if (tokens.length === 0) continue;
    const [rawPattern, ...ownerTokens] = tokens;
    const pattern = rawPattern!.replace(/^\\#/, "#");
    if (pattern.startsWith("!") || /[[\]]/.test(pattern)) continue;
    const owners = ownerTokens.map(parseOwner);
    if (owners.some((owner) => owner === null)) continue;
    rules.push({ pattern, owners: owners as CodeownersOwner[] });
  }
  return rules;
}

/** The owners of the last `*` rule: who owns a path no other rule names. */
export function defaultCodeowners(rules: readonly CodeownersRule[]): CodeownersOwner[] {
  for (let index = rules.length - 1; index >= 0; index--) {
    if (rules[index]!.pattern === "*") return rules[index]!.owners;
  }
  return [];
}

/** Every distinct owner handle the rules name, in first-seen order. */
export function codeownersHandles(rules: readonly CodeownersRule[]): string[] {
  return [...new Set(rules.flatMap((rule) => rule.owners.map((owner) => owner.handle)))];
}

// ---------------------------------------------------------------------------
// API contracts
// ---------------------------------------------------------------------------

const dependsOnEntrySchema = z
  .string()
  .trim()
  .refine((value) => parseRepositoryFullName(value) !== null, "Expected owner/name")
  .transform((value) => value.toLowerCase());

/** PUT body: replaces every ownership field; null clears one. */
export const repoOwnershipInputSchema = z.strictObject({
  ownerTeamId: z.string().min(1).nullable(),
  tier: repoTierSchema.nullable(),
  repoClass: repoClassSchema.nullable(),
  domain: z.string().trim().min(1).max(REPO_DOMAIN_MAX_CHARS).nullable(),
  dependsOn: z.array(dependsOnEntrySchema).max(REPO_DEPENDS_ON_MAX).nullable(),
});
export type RepoOwnershipInput = z.output<typeof repoOwnershipInputSchema>;

export const repoOwnerTeamSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});
export type RepoOwnerTeam = z.infer<typeof repoOwnerTeamSchema>;

export const repoOwnershipSchema = z.object({
  /** Lowercase `owner/name`. */
  repo: z.string(),
  ownerTeam: repoOwnerTeamSchema.nullable(),
  tier: repoTierSchema.nullable(),
  /** As stored; null means unclassified. */
  repoClass: repoClassSchema.nullable(),
  /** What every consumer applies: {@link effectiveRepoClass} of `repoClass`. */
  effectiveRepoClass: repoClassSchema,
  domain: z.string().nullable(),
  dependsOn: z.array(z.string()).nullable(),
  /** Null until the first sync, and when the repository has no CODEOWNERS file. */
  codeowners: z.array(codeownersRuleSchema).nullable(),
  /** Epoch ms of the last successful CODEOWNERS sync; null until the first. */
  codeownersSyncedAt: z.number().int().nullable(),
});
export type RepoOwnership = z.infer<typeof repoOwnershipSchema>;

export const repoOwnershipResponseSchema = z.object({ ownership: repoOwnershipSchema });
export const repoOwnershipListResponseSchema = z.object({
  repos: z.array(repoOwnershipSchema),
});
export type RepoOwnershipListResponse = z.infer<typeof repoOwnershipListResponseSchema>;
