/**
 * GitHub App calls for the protected-path hold: list a PR's changed files,
 * add/remove the hold label, and comment. Each call mints an installation
 * token scoped to the one repository the event names.
 */

import { z } from "zod";
import {
  fetchWithTimeout,
  getCachedInstallationToken,
  type GitHubAppConfig,
} from "../auth/github-app";
import type { CacheStore } from "@open-inspect/shared/cache-store";
import { repositoryCredentialScope } from "../source-control/credential-scope";
import { GITHUB_API_BASE } from "../source-control/providers/constants";
import type { HoldPullRequestRef, ProtectedPathHoldGitHub } from "./pull-request-lifecycle";

const FILES_PER_PAGE = 100;
/** GitHub's list-PR-files endpoint returns at most this many files. */
const MAX_LISTABLE_FILES = 3000;

const pullRequestFilesSchema = z.array(
  z.object({ filename: z.string(), previous_filename: z.string().optional() })
);

export function createProtectedPathGitHub(
  appConfig: GitHubAppConfig,
  bindings: { cacheStore?: CacheStore; userAgent: string }
): ProtectedPathHoldGitHub {
  async function request(
    pr: HoldPullRequestRef,
    path: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<Response> {
    const token = await getCachedInstallationToken(appConfig, bindings, {
      scope: repositoryCredentialScope([pr.repositoryId]),
    });
    const base = `${GITHUB_API_BASE}/repos/${encodeURIComponent(pr.repoOwner)}/${encodeURIComponent(pr.repoName)}`;
    return fetchWithTimeout(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": bindings.userAgent,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  async function expectOk(response: Response, operation: string): Promise<void> {
    if (!response.ok) throw new Error(`GitHub ${operation} failed (status ${response.status})`);
  }

  return {
    async listChangedFiles(pr) {
      const files: string[] = [];
      for (let page = 1; ; page++) {
        const response = await request(
          pr,
          `/pulls/${pr.number}/files?per_page=${FILES_PER_PAGE}&page=${page}`
        );
        await expectOk(response, "list pull request files");
        const entries = pullRequestFilesSchema.parse(await response.json());
        // A rename touches both paths: moving a protected file out is a change to it.
        for (const entry of entries) {
          files.push(entry.filename);
          if (entry.previous_filename) files.push(entry.previous_filename);
        }
        if (entries.length < FILES_PER_PAGE) return files;
        // GitHub silently stops listing here; an unverifiable diff must not read as clear.
        if (page * FILES_PER_PAGE >= MAX_LISTABLE_FILES) {
          throw new Error(`Pull request lists ${MAX_LISTABLE_FILES}+ files; cannot verify paths`);
        }
      }
    },
    async addLabel(pr, label) {
      const response = await request(pr, `/issues/${pr.number}/labels`, {
        method: "POST",
        body: { labels: [label] },
      });
      await expectOk(response, "add label");
    },
    async removeLabel(pr, label) {
      const response = await request(
        pr,
        `/issues/${pr.number}/labels/${encodeURIComponent(label)}`,
        { method: "DELETE" }
      );
      // 404: the label was already removed (e.g. by a human).
      if (response.status !== 404) await expectOk(response, "remove label");
    },
    async comment(pr, body) {
      const response = await request(pr, `/issues/${pr.number}/comments`, {
        method: "POST",
        body: { body },
      });
      await expectOk(response, "comment");
    },
  };
}
