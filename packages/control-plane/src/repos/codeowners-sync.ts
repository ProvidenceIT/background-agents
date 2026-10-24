/**
 * Mirrors each onboarded repository's CODEOWNERS file into `repo_metadata`.
 *
 * A repository is onboarded once any ownership field is set (see
 * RepoMetadataStore.listCodeownersSyncDue). The sync rides the every-minute
 * scheduler tick and gates itself on each row's `codeowners_synced_at`, so it
 * reads each repository about once a day, and a deployment with nothing due
 * costs one indexed read a minute. Files are read through the GitHub App
 * installation from the default branch, in GitHub's lookup order. A
 * repository the installation cannot see is skipped without being marked, so
 * it is retried on the next tick rather than recorded as having no owners.
 */

import { resolveAppName } from "@open-inspect/shared/app-name";
import type { CacheStore } from "@open-inspect/shared/cache-store";
import { parseCodeowners } from "@open-inspect/shared/types/repo-ownership";
import {
  fetchWithTimeout,
  getCachedInstallationToken,
  getGitHubAppConfig,
  getInstallationTokenCacheKey,
  invalidateInstallationTokenCache,
  type GitHubAppConfig,
} from "../auth/github-app";
import { RepoMetadataStore } from "../db/repo-metadata";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { Env } from "../types";

export const CODEOWNERS_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Where GitHub looks for the file, in the order it looks; the first found wins. */
const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

/** GitHub ignores a CODEOWNERS file larger than this. */
const CODEOWNERS_MAX_BYTES = 3 * 1024 * 1024;

/** The GitHub reads the sync makes; the production client goes through the App installation. */
export interface CodeownersFileClient {
  /** The file's text; null when the repository has none; throws when the repository is unreachable. */
  readCodeowners(owner: string, name: string): Promise<string | null>;
}

export interface CodeownersSyncResult {
  /** Lowercase `owner/name` of each repository recorded this run. */
  synced: string[];
  /** Repositories skipped this run; they stay due. */
  failed: string[];
}

export function createCodeownersFileClient(
  config: GitHubAppConfig,
  tokenEnv: { cacheStore?: CacheStore; userAgent: string }
): CodeownersFileClient {
  const scope = { kind: "all" } as const;
  const get = async (path: string, accept: string): Promise<Response> => {
    const url = `https://api.github.com${path}`;
    const request = async (forceRefresh: boolean) =>
      fetchWithTimeout(url, {
        headers: {
          Authorization: `Bearer ${await getCachedInstallationToken(config, tokenEnv, { scope, forceRefresh })}`,
          Accept: accept,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": tokenEnv.userAgent,
        },
      });
    let response = await request(false);
    if (response.status === 401) {
      await invalidateInstallationTokenCache(
        tokenEnv,
        await getInstallationTokenCacheKey(config, scope)
      );
      response = await request(true);
    }
    return response;
  };
  return {
    async readCodeowners(owner, name) {
      const repo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
      // A 404 on a file is only "no file" once the repository itself is visible.
      const reachable = await get(repo, "application/vnd.github+json");
      if (!reachable.ok) {
        throw new Error(`Repository ${owner}/${name} is unreachable: ${reachable.status}`);
      }
      for (const path of CODEOWNERS_PATHS) {
        const response = await get(`${repo}/contents/${path}`, "application/vnd.github.raw");
        if (response.status === 404) continue;
        if (!response.ok) {
          throw new Error(`Failed to read ${owner}/${name}/${path}: ${response.status}`);
        }
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > CODEOWNERS_MAX_BYTES) {
          throw new Error(`${owner}/${name}/${path} exceeds ${CODEOWNERS_MAX_BYTES} bytes`);
        }
        return text;
      }
      return null;
    },
  };
}

/** Syncs every repository due at `nowMs`, one at a time; a failure skips only that repository. */
export async function syncCodeowners(
  db: SqlDatabase,
  client: CodeownersFileClient,
  log: Logger,
  nowMs: number
): Promise<CodeownersSyncResult> {
  const store = new RepoMetadataStore(db);
  const result: CodeownersSyncResult = { synced: [], failed: [] };
  for (const { owner, name } of await store.listCodeownersSyncDue(
    nowMs - CODEOWNERS_SYNC_INTERVAL_MS
  )) {
    const repo = `${owner}/${name}`;
    try {
      const text = await client.readCodeowners(owner, name);
      const rules = text === null ? null : parseCodeowners(text);
      await store.setCodeowners(owner, name, rules, nowMs);
      result.synced.push(repo);
      log.info("codeowners_sync.repo_synced", {
        repo,
        has_file: text !== null,
        rule_count: rules?.length ?? 0,
      });
    } catch (error) {
      result.failed.push(repo);
      log.warn("codeowners_sync.repo_skipped", {
        repo,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return result;
}

/** The scheduled entry point: nothing to do without GitHub App credentials or due repositories. */
export async function runCodeownersSync(
  env: Env,
  db: SqlDatabase,
  log: Logger,
  nowMs: number
): Promise<CodeownersSyncResult> {
  const config = getGitHubAppConfig(env);
  if (!config) return { synced: [], failed: [] };
  const client = createCodeownersFileClient(config, {
    cacheStore: env.REPOS_CACHE,
    userAgent: resolveAppName(env),
  });
  return syncCodeowners(db, client, log, nowMs);
}
