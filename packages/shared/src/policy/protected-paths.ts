/**
 * Protected paths: the deterministic layer behind the FACTORY_RULES hold
 * categories. An agent pull request that changes a protected path is held
 * for human review; code (not the model) decides what is protected.
 *
 * Glob syntax is `matchGlob`'s, plus one gitignore-style rule: a glob with
 * no `/` matches a file's base name at any depth (`*.pem` matches
 * `certs/dev.pem`, `CODEOWNERS` matches `docs/CODEOWNERS`).
 */

import { z } from "zod";
import { matchGlob } from "../triggers/glob";

export const PROTECTED_PATH_CATEGORIES = [
  "governance",
  "db_migration",
  "auth",
  "billing",
  "secrets",
] as const;

export type ProtectedPathCategory = (typeof PROTECTED_PATH_CATEGORIES)[number];

/** One protected glob and the FACTORY_RULES category it holds under. */
export interface ProtectedPathGlob {
  glob: string;
  category: ProtectedPathCategory;
}

/** One changed file that a protected glob matched. */
export interface ProtectedPathMatch {
  path: string;
  category: ProtectedPathCategory;
  glob: string;
}

/** Protected for every repository; per-repo policies add to these, never remove. */
export const DEFAULT_PROTECTED_PATHS: readonly ProtectedPathGlob[] = [
  // governance: the factory's own rules, CI, review routing, deploy and harness config
  { glob: "AGENTS.md", category: "governance" },
  { glob: "CLAUDE.md", category: "governance" },
  { glob: ".github/workflows/**", category: "governance" },
  { glob: "CODEOWNERS", category: "governance" },
  { glob: ".github/CODEOWNERS", category: "governance" },
  { glob: "deploy/**", category: "governance" },
  { glob: ".openinspect/**", category: "governance" },
  { glob: ".claude/**", category: "governance" },
  { glob: ".codex/**", category: "governance" },
  { glob: ".opencode/**", category: "governance" },
  { glob: "opencode.json", category: "governance" },
  { glob: ".mcp.json", category: "governance" },
  // db_migration
  { glob: "**/migrations/**", category: "db_migration" },
  { glob: "terraform/d1/migrations/**", category: "db_migration" },
  { glob: "**/*.sql", category: "db_migration" },
  // auth
  { glob: "**/auth/**", category: "auth" },
  { glob: "**/authorization/**", category: "auth" },
  { glob: "**/identity/**", category: "auth" },
  // billing
  { glob: "**/billing/**", category: "billing" },
  // secrets
  { glob: "**/secrets/**", category: "secrets" },
  { glob: "*.pem", category: "secrets" },
  { glob: ".env*", category: "secrets" },
];

export const MAX_REPO_PROTECTED_PATH_GLOBS = 100;
const MAX_GLOB_LENGTH = 200;

/** A repo-policy glob as accepted at the settings API and storage boundaries. */
export const protectedPathGlobSchema = z
  .object({
    glob: z
      .string()
      .trim()
      .min(1)
      .max(MAX_GLOB_LENGTH)
      .refine((glob) => !glob.startsWith("/"), "Globs are relative to the repository root"),
    category: z.enum(PROTECTED_PATH_CATEGORIES),
  })
  .strict();

export const protectedPathGlobListSchema = z
  .array(protectedPathGlobSchema)
  .max(MAX_REPO_PROTECTED_PATH_GLOBS);

/** PUT /repos/:owner/:name/path-policy body. */
export const repoPathPolicyInputSchema = z.object({ globs: protectedPathGlobListSchema }).strict();

/** A repository's extra protected globs (the defaults always apply on top). */
export interface RepoPathPolicy {
  repoOwner: string;
  repoName: string;
  globs: ProtectedPathGlob[];
  updatedBy: string;
  updatedAt: number;
}

function globMatchesPath(glob: string, path: string): boolean {
  if (glob.includes("/")) return matchGlob(glob, path);
  const baseName = path.slice(path.lastIndexOf("/") + 1);
  return matchGlob(glob, baseName);
}

/**
 * Every (file, category) pair a protected glob matches, in file order. The
 * first matching glob per category is reported; a file can match several
 * categories (e.g. `deploy/migrations/0001.sql`).
 */
export function matchProtectedPaths(
  files: readonly string[],
  globs: readonly ProtectedPathGlob[] = DEFAULT_PROTECTED_PATHS
): ProtectedPathMatch[] {
  const matches: ProtectedPathMatch[] = [];
  for (const path of files) {
    const seen = new Set<ProtectedPathCategory>();
    for (const { glob, category } of globs) {
      if (seen.has(category) || !globMatchesPath(glob, path)) continue;
      seen.add(category);
      matches.push({ path, category, glob });
    }
  }
  return matches;
}
