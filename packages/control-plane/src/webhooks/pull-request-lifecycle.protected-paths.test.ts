import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubAutomationEvent } from "@open-inspect/shared/triggers";
import { RepoPathPolicyStore } from "../db/repo-path-policies";
import { SessionPullRequestStore } from "../db/session-pull-request-store";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import {
  processProtectedPathHold,
  PROTECTED_PATH_HOLD_LABEL,
  type ProtectedPathHoldGitHub,
} from "./pull-request-lifecycle";

const PR_REF = { repositoryId: 9001, repoOwner: "acme", repoName: "web", number: 7 };

function pushEvent(
  headSha: string,
  eventType = "pull_request.synchronize",
  facts: Partial<NonNullable<GitHubAutomationEvent["pullRequest"]>> = {}
): GitHubAutomationEvent {
  return {
    source: "github",
    eventType,
    triggerKey: `pr:7:synchronize:${headSha}`,
    concurrencyKey: "pr:7",
    contextBlock: "",
    meta: {},
    repositoryId: 9001,
    repoOwner: "acme",
    repoName: "web",
    branch: "open-inspect/session-1",
    targetBranch: "main",
    pullRequest: {
      number: 7,
      state: "open",
      draft: false,
      headSha,
      isCrossRepository: false,
      url: "https://github.com/acme/web/pull/7",
      repositoryExternalId: "9001",
      ...facts,
    },
  };
}

describe("processProtectedPathHold", () => {
  let sqlite: NodeSqlDatabase;
  let store: SessionPullRequestStore;
  let changedFiles: string[];
  let github: { [K in keyof ProtectedPathHoldGitHub]: ReturnType<typeof vi.fn> };

  /** The lifecycle step has already moved the session's record to `headSha`. */
  async function seedSessionPullRequest(headSha: string): Promise<void> {
    await store.upsert({
      artifactId: "artifact-1",
      sessionId: "session-1",
      repositoryExternalId: "9001",
      repoOwner: "acme",
      repoName: "web",
      prNumber: 7,
      url: "https://github.com/acme/web/pull/7",
      lifecycleState: "open",
      isDraft: false,
      headBranch: "open-inspect/session-1",
      baseBranch: "main",
      headSha,
      providerCreatedAt: null,
      providerUpdatedAt: null,
      mergedAt: null,
      closedAt: null,
      createdAt: 100,
      updatedAt: 100,
    });
  }

  function run(event: GitHubAutomationEvent) {
    return processProtectedPathHold(
      {
        store,
        policies: new RepoPathPolicyStore(sqlite),
        github: github as unknown as ProtectedPathHoldGitHub,
      },
      event
    );
  }

  beforeEach(async () => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(
      database,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    sqlite = createNodeSqlDatabase(database);
    store = new SessionPullRequestStore(sqlite);
    await sqlite
      .prepare("INSERT INTO sessions (id, created_at, updated_at) VALUES ('session-1', 1, 1)")
      .run();
    changedFiles = [];
    github = {
      listChangedFiles: vi.fn(async () => changedFiles),
      addLabel: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}),
      comment: vi.fn(async () => {}),
    };
  });
  afterEach(() => sqlite.close());

  it("holds a PR that changes .github/workflows/ci.yml at its head SHA as governance", async () => {
    await seedSessionPullRequest("sha-1");
    changedFiles = ["src/index.ts", ".github/workflows/ci.yml"];

    expect(await run(pushEvent("sha-1", "pull_request.opened"))).toBe("held");

    expect(await store.getHold({ artifactId: "artifact-1" }, "sha-1")).toEqual({
      state: "held",
      headSha: "sha-1",
      matches: [
        { path: ".github/workflows/ci.yml", category: "governance", glob: ".github/workflows/**" },
      ],
    });
    expect(PROTECTED_PATH_HOLD_LABEL).toBe("sf:hold-protected-path");
    expect(github.addLabel).toHaveBeenCalledWith(PR_REF, "sf:hold-protected-path");
    expect(github.comment).toHaveBeenCalledTimes(1);
    expect(github.comment).toHaveBeenCalledWith(
      PR_REF,
      [
        "**Held for human review:** this pull request changes protected paths (governance) at sha-1.",
        "",
        "- `.github/workflows/ci.yml` (governance)",
        "",
        "The `sf:hold-protected-path` label stays until a push removes these changes; it is never merged automatically.",
      ].join("\n")
    );
  });

  it("holds a PR adding terraform/d1/migrations/0200_x.sql as db_migration", async () => {
    await seedSessionPullRequest("sha-1");
    changedFiles = ["terraform/d1/migrations/0200_x.sql"];

    expect(await run(pushEvent("sha-1"))).toBe("held");

    expect(await store.getHold({ artifactId: "artifact-1" }, "sha-1")).toEqual({
      state: "held",
      headSha: "sha-1",
      matches: [
        {
          path: "terraform/d1/migrations/0200_x.sql",
          category: "db_migration",
          glob: "**/migrations/**",
        },
      ],
    });
  });

  it("records a clear check and touches nothing on GitHub for src-only changes", async () => {
    await seedSessionPullRequest("sha-1");
    changedFiles = ["src/index.ts", "src/lib/util.ts"];

    expect(await run(pushEvent("sha-1"))).toBe("clear");

    expect(await store.getHold({ artifactId: "artifact-1" }, "sha-1")).toEqual({
      state: "clear",
      headSha: "sha-1",
    });
    expect(github.addLabel).not.toHaveBeenCalled();
    expect(github.removeLabel).not.toHaveBeenCalled();
    expect(github.comment).not.toHaveBeenCalled();
  });

  it("clears the hold for the new head when a push removes the protected change", async () => {
    await seedSessionPullRequest("sha-1");
    changedFiles = [".github/workflows/ci.yml"];
    await run(pushEvent("sha-1"));

    await seedSessionPullRequest("sha-2");
    changedFiles = ["src/index.ts"];
    expect(await run(pushEvent("sha-2"))).toBe("clear");

    expect(await store.getHold({ artifactId: "artifact-1" }, "sha-2")).toEqual({
      state: "clear",
      headSha: "sha-2",
    });
    // The old head's verdict is not carried to the new head.
    expect(await store.getHold({ artifactId: "artifact-1" }, "sha-1")).toEqual({
      state: "unchecked",
    });
    expect(github.removeLabel).toHaveBeenCalledWith(PR_REF, "sf:hold-protected-path");
  });

  it("comments once per distinct match set across pushes", async () => {
    await seedSessionPullRequest("sha-1");
    changedFiles = [".github/workflows/ci.yml"];
    await run(pushEvent("sha-1"));
    await seedSessionPullRequest("sha-2");
    await run(pushEvent("sha-2"));

    expect(github.addLabel).toHaveBeenCalledTimes(2);
    expect(github.comment).toHaveBeenCalledTimes(1);
    expect(await store.getHold({ artifactId: "artifact-1" }, "sha-2")).toMatchObject({
      state: "held",
    });
  });

  it("applies the repository's extra globs on top of the defaults", async () => {
    await seedSessionPullRequest("sha-1");
    await new RepoPathPolicyStore(sqlite).put(
      "Acme",
      "Web",
      [{ glob: "infra/**", category: "governance" }],
      "admin-1",
      1
    );
    changedFiles = ["infra/main.tf"];

    expect(await run(pushEvent("sha-1"))).toBe("held");
    expect(await store.getHold({ artifactId: "artifact-1" }, "sha-1")).toEqual({
      state: "held",
      headSha: "sha-1",
      matches: [{ path: "infra/main.tf", category: "governance", glob: "infra/**" }],
    });
  });

  it("drops a late check for a head the record has moved past", async () => {
    await seedSessionPullRequest("sha-2");
    changedFiles = [".github/workflows/ci.yml"];

    expect(await run(pushEvent("sha-1"))).toBe("stale");
    expect(await store.getHold({ artifactId: "artifact-1" }, "sha-2")).toEqual({
      state: "unchecked",
    });
    expect(github.addLabel).not.toHaveBeenCalled();
  });

  it("ignores PRs that no session owns", async () => {
    changedFiles = [".github/workflows/ci.yml"];

    expect(await run(pushEvent("sha-1"))).toBe("not_session_pr");
    expect(github.listChangedFiles).not.toHaveBeenCalled();
    expect(github.addLabel).not.toHaveBeenCalled();
    expect(github.comment).not.toHaveBeenCalled();
  });

  it("ignores events that cannot change the diff, and fork heads", async () => {
    await seedSessionPullRequest("sha-1");
    changedFiles = [".github/workflows/ci.yml"];

    expect(await run(pushEvent("sha-1", "pull_request.closed"))).toBe("not_checked_event");
    expect(await run(pushEvent("sha-1", "pull_request.opened", { isCrossRepository: true }))).toBe(
      "not_checked_event"
    );
    expect(github.listChangedFiles).not.toHaveBeenCalled();
  });

  it("leaves the head unchecked when the files cannot be listed", async () => {
    await seedSessionPullRequest("sha-1");
    github.listChangedFiles.mockRejectedValue(new Error("GitHub list pull request files failed"));

    await expect(run(pushEvent("sha-1"))).rejects.toThrow("list pull request files failed");
    expect(await store.getHold({ artifactId: "artifact-1" }, "sha-1")).toEqual({
      state: "unchecked",
    });
  });
});
