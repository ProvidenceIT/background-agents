import type { RepoMetadata } from "@open-inspect/shared/types/repository-catalog";
import {
  codeownersRuleSchema,
  effectiveRepoClass,
  repoClassSchema,
  repoTierSchema,
  type CodeownersRule,
  type RepoOwnership,
  type RepoOwnershipInput,
} from "@open-inspect/shared/types/repo-ownership";
import { z } from "zod";
import { parseJsonStringArray } from "./json-columns";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlDatabase } from "./sql-database";

const REPOS_PER_QUERY = Math.floor(MAX_D1_QUERY_PARAMETERS / 2);

interface RepoMetadataRow {
  repo_owner: string;
  repo_name: string;
  description: string | null;
  aliases: string | null;
  channel_associations: string | null;
  keywords: string | null;
  default_environment_id: string | null;
  image_build_enabled: number;
  created_at: number;
  updated_at: number;
}

/** The ownership columns (migration 0104) joined with the owning team. */
interface RepoOwnershipRow {
  repo_owner: string;
  repo_name: string;
  owner_team_id: string | null;
  team_slug: string | null;
  team_name: string | null;
  tier: string | null;
  repo_class: string | null;
  domain: string | null;
  depends_on: string | null;
  codeowners: string | null;
  codeowners_synced_at: number | null;
}

const OWNERSHIP_SELECT = `SELECT m.repo_owner, m.repo_name, m.owner_team_id, t.slug AS team_slug,
    t.name AS team_name, m.tier, m.repo_class, m.domain, m.depends_on, m.codeowners,
    m.codeowners_synced_at
  FROM repo_metadata m LEFT JOIN teams t ON t.id = m.owner_team_id`;

/** A repository is onboarded once any ownership field is set; only those are synced and listed. */
const ONBOARDED = "(m.owner_team_id IS NOT NULL OR m.tier IS NOT NULL OR m.repo_class IS NOT NULL)";

const codeownersColumnSchema = z.array(codeownersRuleSchema);

function parseJson<T>(value: string | null, schema: z.ZodType<T>): T | null {
  if (value === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toOwnership(row: RepoOwnershipRow): RepoOwnership {
  // The CHECK constraints keep these columns in range; a value outside the
  // enum still reads as unset, so a corrupt class falls back to client.
  const repoClass = repoClassSchema.safeParse(row.repo_class).data ?? null;
  return {
    repo: `${row.repo_owner}/${row.repo_name}`,
    ownerTeam:
      row.owner_team_id !== null && row.team_slug !== null && row.team_name !== null
        ? { id: row.owner_team_id, slug: row.team_slug, name: row.team_name }
        : null,
    tier: repoTierSchema.safeParse(row.tier).data ?? null,
    repoClass,
    effectiveRepoClass: effectiveRepoClass(repoClass),
    domain: row.domain,
    dependsOn: parseJsonStringArray(row.depends_on) ?? null,
    codeowners: parseJson(row.codeowners, codeownersColumnSchema),
    codeownersSyncedAt: row.codeowners_synced_at,
  };
}

export interface ImageBuildEnabledRepo {
  repoOwner: string;
  repoName: string;
}

function toMetadata(row: RepoMetadataRow): RepoMetadata {
  const metadata: RepoMetadata = {};
  if (row.description != null) metadata.description = row.description;
  const aliases = parseJsonStringArray(row.aliases);
  if (aliases) metadata.aliases = aliases;
  const channelAssociations = parseJsonStringArray(row.channel_associations);
  if (channelAssociations) metadata.channelAssociations = channelAssociations;
  const keywords = parseJsonStringArray(row.keywords);
  if (keywords) metadata.keywords = keywords;
  if (row.default_environment_id != null)
    metadata.defaultEnvironmentId = row.default_environment_id;
  return metadata;
}

export class RepoMetadataStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(owner: string, name: string): Promise<RepoMetadata | null> {
    const row = await this.db
      .prepare("SELECT * FROM repo_metadata WHERE repo_owner = ? AND repo_name = ?")
      .bind(owner.toLowerCase(), name.toLowerCase())
      .first<RepoMetadataRow>();

    return row ? toMetadata(row) : null;
  }

  async upsert(owner: string, name: string, metadata: RepoMetadata): Promise<void> {
    const now = Date.now();
    const normalizedOwner = owner.toLowerCase();
    const normalizedName = name.toLowerCase();

    await this.db
      .prepare(
        `INSERT INTO repo_metadata (repo_owner, repo_name, description, aliases, channel_associations, keywords, default_environment_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_owner, repo_name) DO UPDATE SET
           description = excluded.description,
           aliases = excluded.aliases,
           channel_associations = excluded.channel_associations,
           keywords = excluded.keywords,
           default_environment_id = excluded.default_environment_id,
           updated_at = excluded.updated_at`
      )
      .bind(
        normalizedOwner,
        normalizedName,
        metadata.description ?? null,
        metadata.aliases ? JSON.stringify(metadata.aliases) : null,
        metadata.channelAssociations ? JSON.stringify(metadata.channelAssociations) : null,
        metadata.keywords ? JSON.stringify(metadata.keywords) : null,
        metadata.defaultEnvironmentId ?? null,
        now,
        now
      )
      .run();
  }

  async getBatch(
    repos: Array<{ owner: string; name: string }>
  ): Promise<Map<string, RepoMetadata>> {
    if (repos.length === 0) return new Map();

    const map = new Map<string, RepoMetadata>();
    const uniqueRepos = new Map<string, { owner: string; name: string }>();
    for (const repo of repos) {
      const owner = repo.owner.toLowerCase();
      const name = repo.name.toLowerCase();
      uniqueRepos.set(`${owner}/${name}`, { owner, name });
    }
    const normalizedRepos = [...uniqueRepos.values()];

    for (let start = 0; start < normalizedRepos.length; start += REPOS_PER_QUERY) {
      const chunk = normalizedRepos.slice(start, start + REPOS_PER_QUERY);
      const predicates = chunk.map(() => "(repo_owner = ? AND repo_name = ?)").join(" OR ");
      const result = await this.db
        .prepare(`SELECT * FROM repo_metadata WHERE ${predicates}`)
        .bind(...chunk.flatMap((repo) => [repo.owner, repo.name]))
        .all<RepoMetadataRow>();

      for (const row of result.results) {
        map.set(`${row.repo_owner.toLowerCase()}/${row.repo_name.toLowerCase()}`, toMetadata(row));
      }
    }

    return map;
  }

  /** False when no repo_metadata row exists — an unknown repo is never prebuild-enabled. */
  async getImageBuildEnabled(owner: string, name: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT image_build_enabled FROM repo_metadata WHERE repo_owner = ? AND repo_name = ?"
      )
      .bind(owner.toLowerCase(), name.toLowerCase())
      .first<{ image_build_enabled: number }>();

    return row?.image_build_enabled === 1;
  }

  /** Null when the repository has no repo_metadata row at all. */
  async getOwnership(owner: string, name: string): Promise<RepoOwnership | null> {
    const row = await this.db
      .prepare(`${OWNERSHIP_SELECT} WHERE m.repo_owner = ? AND m.repo_name = ?`)
      .bind(owner.toLowerCase(), name.toLowerCase())
      .first<RepoOwnershipRow>();
    return row ? toOwnership(row) : null;
  }

  /** Every onboarded repository, by name. */
  async listOwnership(): Promise<RepoOwnership[]> {
    const result = await this.db
      .prepare(`${OWNERSHIP_SELECT} WHERE ${ONBOARDED} ORDER BY m.repo_owner, m.repo_name`)
      .all<RepoOwnershipRow>();
    return result.results.map(toOwnership);
  }

  /** Replaces every ownership field; CODEOWNERS state is the sync's and stays as it is. */
  async setOwnership(owner: string, name: string, input: RepoOwnershipInput): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO repo_metadata (repo_owner, repo_name, owner_team_id, tier, repo_class, domain, depends_on, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_owner, repo_name) DO UPDATE SET
           owner_team_id = excluded.owner_team_id,
           tier = excluded.tier,
           repo_class = excluded.repo_class,
           domain = excluded.domain,
           depends_on = excluded.depends_on,
           updated_at = excluded.updated_at`
      )
      .bind(
        owner.toLowerCase(),
        name.toLowerCase(),
        input.ownerTeamId,
        input.tier,
        input.repoClass,
        input.domain,
        input.dependsOn ? JSON.stringify(input.dependsOn) : null,
        now,
        now
      )
      .run();
  }

  /** Onboarded repositories whose CODEOWNERS were never synced or last synced before `staleBeforeMs`. */
  async listCodeownersSyncDue(
    staleBeforeMs: number
  ): Promise<Array<{ owner: string; name: string }>> {
    const result = await this.db
      .prepare(
        `SELECT m.repo_owner, m.repo_name FROM repo_metadata m
         WHERE ${ONBOARDED} AND (m.codeowners_synced_at IS NULL OR m.codeowners_synced_at < ?)
         ORDER BY m.repo_owner, m.repo_name`
      )
      .bind(staleBeforeMs)
      .all<{ repo_owner: string; repo_name: string }>();
    return result.results.map((row) => ({ owner: row.repo_owner, name: row.repo_name }));
  }

  /** Records a sync: the parsed rules, or null when the repository has no CODEOWNERS file. */
  async setCodeowners(
    owner: string,
    name: string,
    rules: readonly CodeownersRule[] | null,
    syncedAtMs: number
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE repo_metadata SET codeowners = ?, codeowners_synced_at = ?
         WHERE repo_owner = ? AND repo_name = ?`
      )
      .bind(
        rules ? JSON.stringify(rules) : null,
        syncedAtMs,
        owner.toLowerCase(),
        name.toLowerCase()
      )
      .run();
  }

  async getImageBuildEnabledRepos(): Promise<ImageBuildEnabledRepo[]> {
    const result = await this.db
      .prepare("SELECT repo_owner, repo_name FROM repo_metadata WHERE image_build_enabled = 1")
      .all<{ repo_owner: string; repo_name: string }>();

    return (result.results || []).map((row) => ({
      repoOwner: row.repo_owner,
      repoName: row.repo_name,
    }));
  }

  async setImageBuildEnabled(owner: string, name: string, enabled: boolean): Promise<void> {
    const now = Date.now();
    const normalizedOwner = owner.toLowerCase();
    const normalizedName = name.toLowerCase();

    await this.db
      .prepare(
        `INSERT INTO repo_metadata (repo_owner, repo_name, image_build_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repo_owner, repo_name) DO UPDATE SET
           image_build_enabled = excluded.image_build_enabled,
           updated_at = excluded.updated_at`
      )
      .bind(normalizedOwner, normalizedName, enabled ? 1 : 0, now, now)
      .run();
  }
}
