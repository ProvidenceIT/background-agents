import {
  protectedPathGlobListSchema,
  type ProtectedPathGlob,
  type RepoPathPolicy,
} from "@open-inspect/shared/policy/protected-paths";
import type { SqlDatabase } from "./sql-database";

interface RepoPathPolicyRow {
  repo_owner: string;
  repo_name: string;
  globs: string;
  updated_by: string;
  updated_at: number;
}

/**
 * A stored policy that no longer parses must not silently drop a repo's
 * extra protected globs, so it throws: the hold check then fails and the
 * PR stays unchecked (held) instead of passing with the defaults only.
 */
function toPolicy(row: RepoPathPolicyRow): RepoPathPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(row.globs);
  } catch {
    raw = undefined;
  }
  const globs = protectedPathGlobListSchema.safeParse(raw);
  if (!globs.success) {
    throw new Error(`Corrupt repo_path_policies globs for ${row.repo_owner}/${row.repo_name}`);
  }
  return {
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    globs: globs.data,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

/** D1 store for per-repository protected globs, keyed by lowercased owner/name. */
export class RepoPathPolicyStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(owner: string, name: string): Promise<RepoPathPolicy | null> {
    const row = await this.db
      .prepare("SELECT * FROM repo_path_policies WHERE repo_owner = ? AND repo_name = ?")
      .bind(owner.toLowerCase(), name.toLowerCase())
      .first<RepoPathPolicyRow>();
    return row ? toPolicy(row) : null;
  }

  /** Replace the repository's extra globs; returns the stored policy. */
  async put(
    owner: string,
    name: string,
    globs: ProtectedPathGlob[],
    updatedBy: string,
    now: number
  ): Promise<RepoPathPolicy> {
    const row: RepoPathPolicyRow = {
      repo_owner: owner.toLowerCase(),
      repo_name: name.toLowerCase(),
      globs: JSON.stringify(globs),
      updated_by: updatedBy,
      updated_at: now,
    };
    await this.db
      .prepare(
        `INSERT INTO repo_path_policies (repo_owner, repo_name, globs, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (repo_owner, repo_name) DO UPDATE SET
           globs = excluded.globs,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`
      )
      .bind(row.repo_owner, row.repo_name, row.globs, row.updated_by, row.updated_at)
      .run();
    return toPolicy(row);
  }
}
