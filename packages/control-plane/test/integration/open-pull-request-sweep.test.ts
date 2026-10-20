/**
 * The open-PR sweep end to end on workerd: the cron reaches the sweep, which
 * stamps D1 and asks the session's Durable Object to refresh; and the Durable
 * Object's refresh route answers 404 for a session that does not exist.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../../src/index";
import { SessionIndexStore } from "../../src/db/session-index";
import { SessionPullRequestStore } from "../../src/db/session-pull-request-store";
import { SCHEDULER_TICK_CRON } from "../../src/scheduled-jobs";
import { OPEN_PULL_REQUEST_SWEEP_CRON } from "../../src/session/open-pull-request-sweep";
import type { WorkerBindings } from "../../src/cloudflare/platform";
import { cleanD1Tables } from "./cleanup";
import { initNamedSessionDO } from "./helpers";

async function seedOpenPullRequest(sessionId: string): Promise<void> {
  const now = Date.now();
  await new SessionIndexStore(env.DB).create({
    id: sessionId,
    ownerTeamId: null,
    visibility: "workspace",
    title: null,
    repoOwner: "acme",
    repoName: "web-app",
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: "main",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await new SessionPullRequestStore(env.DB).upsert({
    artifactId: `${sessionId}-pr`,
    sessionId,
    repositoryExternalId: "12345",
    repoOwner: "acme",
    repoName: "web-app",
    prNumber: 7,
    url: "https://github.com/acme/web-app/pull/7",
    lifecycleState: "open",
    isDraft: false,
    headBranch: `open-inspect/${sessionId}`,
    baseBranch: "main",
    headSha: null,
    providerCreatedAt: null,
    providerUpdatedAt: 1_000,
    mergedAt: null,
    closedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function sweepStamp(sessionId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT sweep_attempted_at FROM session_pull_requests WHERE session_id = ?"
  )
    .bind(sessionId)
    .first<{ sweep_attempted_at: number | null }>();
  return row?.sweep_attempted_at ?? null;
}

function createSessionNamespace() {
  const requests: string[] = [];
  return {
    requests,
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({
      fetch: vi.fn(async (request: Request) => {
        requests.push(`${request.method} ${request.url}`);
        return Response.json({ status: "refreshing" }, { status: 202 });
      }),
    })),
  };
}

describe("open pull request sweep cron routing", () => {
  beforeEach(cleanD1Tables);

  it("stamps the session's open PR and asks its runtime to refresh", async () => {
    await seedOpenPullRequest("stale-pr");
    const sessionNamespace = createSessionNamespace();
    const before = Date.now();

    await worker.scheduled(
      { cron: OPEN_PULL_REQUEST_SWEEP_CRON } as ScheduledEvent,
      { DB: env.DB, SESSION: sessionNamespace } as unknown as WorkerBindings,
      createExecutionContext()
    );

    expect(sessionNamespace.idFromName).toHaveBeenCalledWith("stale-pr");
    expect(sessionNamespace.requests).toEqual([
      "POST http://internal/internal/pull-requests-refresh?trigger=sweep",
    ]);
    expect(await sweepStamp("stale-pr")).toBeGreaterThanOrEqual(before);
  });

  it("leaves open PRs alone on the automation tick", async () => {
    await seedOpenPullRequest("stale-pr");
    const sessionNamespace = createSessionNamespace();

    await worker.scheduled(
      { cron: SCHEDULER_TICK_CRON } as ScheduledEvent,
      { DB: env.DB, SESSION: sessionNamespace } as unknown as WorkerBindings,
      createExecutionContext()
    );

    expect(sessionNamespace.idFromName).not.toHaveBeenCalled();
    expect(await sweepStamp("stale-pr")).toBeNull();
  });
});

describe("POST /internal/pull-requests-refresh", () => {
  it("accepts a sweep-triggered refresh for an existing session", async () => {
    const { stub } = await initNamedSessionDO(`pr-sweep-${Date.now()}`);

    const res = await stub.fetch("http://internal/internal/pull-requests-refresh?trigger=sweep", {
      method: "POST",
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "refreshing" });
  });

  it("answers 404 when the Durable Object holds no session", async () => {
    const stub = env.SESSION.get(env.SESSION.newUniqueId());

    const res = await stub.fetch("http://internal/internal/pull-requests-refresh?trigger=sweep", {
      method: "POST",
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Session not found" });
  });
});
