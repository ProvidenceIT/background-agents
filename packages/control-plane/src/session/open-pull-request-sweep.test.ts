import { describe, expect, it, vi } from "vitest";
import {
  OpenPullRequestSweep,
  SessionPullRequestRefreshClient,
  type OpenPullRequestIndex,
  type PullRequestRefreshClient,
  type PullRequestRefreshOutcome,
} from "./open-pull-request-sweep";
import type { Logger } from "../logger";
import { SessionInternalPaths } from "./contracts";
import type { SessionRuntimeClient } from "./runtime-client";

const NOW = 1_000_000_000;
const RECHECK_MS = 15 * 60 * 1000;

function createLog(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

/** Records list, stamp and refresh calls in one sequence so their order can be asserted. */
function createFakes(
  ids: string[] | Error,
  outcomes: Record<string, PullRequestRefreshOutcome | Error> = {},
  stampError?: Error
) {
  const calls: string[] = [];
  const index: OpenPullRequestIndex = {
    listOpenPullRequestSessionIdsForSweep: vi.fn(async () => {
      calls.push("list");
      if (ids instanceof Error) throw ids;
      return ids;
    }),
    markSweepAttempted: vi.fn(async (sessionIds: readonly string[]) => {
      calls.push(`stamp:${sessionIds.join(",")}`);
      if (stampError) throw stampError;
    }),
  };
  const client: PullRequestRefreshClient = {
    requestRefresh: vi.fn(async (sessionId: string) => {
      calls.push(`refresh:${sessionId}`);
      const outcome = outcomes[sessionId] ?? "refreshing";
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
  };
  return { calls, index, client };
}

describe("OpenPullRequestSweep", () => {
  it("queries sessions not attempted within the recheck interval, up to the limit", async () => {
    const { index, client } = createFakes([]);

    await new OpenPullRequestSweep(index, client, createLog(), RECHECK_MS, 25).run(NOW);

    expect(index.listOpenPullRequestSessionIdsForSweep).toHaveBeenCalledWith(NOW - RECHECK_MS, 25);
  });

  it("does nothing when no session holds a stale open pull request", async () => {
    const { calls, index, client } = createFakes([]);
    const log = createLog();

    const result = await new OpenPullRequestSweep(index, client, log, RECHECK_MS, 25).run(NOW);

    expect(result).toEqual({
      candidates: 0,
      refreshing: 0,
      missing: 0,
      errored: 0,
      truncated: false,
    });
    expect(calls).toEqual(["list"]);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("stamps the whole batch before asking any session to refresh", async () => {
    const { calls, index, client } = createFakes(["a", "b"]);

    await new OpenPullRequestSweep(index, client, createLog(), RECHECK_MS, 25).run(NOW);

    // Stamping first is the back-off: a session whose refresh fails has already
    // moved behind every session not yet attempted.
    expect(calls).toEqual(["list", "stamp:a,b", "refresh:a", "refresh:b"]);
    expect(index.markSweepAttempted).toHaveBeenCalledWith(["a", "b"], NOW);
  });

  it("counts refreshing, missing and errored sessions and logs one summary", async () => {
    const log = createLog();
    const { index, client } = createFakes(["ok-1", "ok-2", "gone", "broken"], {
      gone: "missing",
      broken: new Error("status 500"),
    });

    const result = await new OpenPullRequestSweep(index, client, log, RECHECK_MS, 25).run(NOW);

    expect(result).toEqual({
      candidates: 4,
      refreshing: 2,
      missing: 1,
      errored: 1,
      truncated: false,
    });
    expect(log.warn).toHaveBeenCalledWith("Open pull request refresh request failed", {
      event: "scheduler.open_pull_request_refresh_failed",
      session_id: "broken",
      error: "status 500",
    });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith("Open pull request sweep completed", {
      event: "scheduler.open_pull_request_sweep",
      candidates: 4,
      refreshing: 2,
      missing: 1,
      errored: 1,
      truncated: false,
    });
  });

  it("reports truncation when the batch fills the limit", async () => {
    const { index, client } = createFakes(["a", "b"]);

    const result = await new OpenPullRequestSweep(index, client, createLog(), RECHECK_MS, 2).run(
      NOW
    );

    expect(index.listOpenPullRequestSessionIdsForSweep).toHaveBeenCalledWith(NOW - RECHECK_MS, 2);
    expect(result).toEqual({
      candidates: 2,
      refreshing: 2,
      missing: 0,
      errored: 0,
      truncated: true,
    });
  });

  it("gives up without touching sessions when the candidate query fails", async () => {
    const log = createLog();
    const { calls, index, client } = createFakes(new Error("d1 unavailable"));

    const result = await new OpenPullRequestSweep(index, client, log, RECHECK_MS, 25).run(NOW);

    expect(result).toEqual({
      candidates: 0,
      refreshing: 0,
      missing: 0,
      errored: 0,
      truncated: false,
    });
    expect(calls).toEqual(["list"]);
    expect(log.error).toHaveBeenCalledWith(
      "Open pull request sweep failed to read or stamp candidates",
      {
        event: "scheduler.open_pull_request_sweep_query_failed",
        error: "d1 unavailable",
      }
    );
  });

  it("does not dispatch an unstamped batch, which the next run would read again", async () => {
    const log = createLog();
    const { calls, index, client } = createFakes(["a"], {}, new Error("d1 write failed"));

    const result = await new OpenPullRequestSweep(index, client, log, RECHECK_MS, 25).run(NOW);

    expect(result.candidates).toBe(0);
    expect(calls).toEqual(["list", "stamp:a"]);
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe("SessionPullRequestRefreshClient", () => {
  function createSessions(response: Response) {
    const fetch = vi.fn(
      async (_sessionId: string, _path: string, _init?: RequestInit, _search?: string) => response
    );
    return { sessions: { fetch } satisfies SessionRuntimeClient, fetch };
  }

  it("posts to the session's refresh route, labelled as the sweep and bounded in time", async () => {
    const { sessions, fetch } = createSessions(
      Response.json({ status: "refreshing" }, { status: 202 })
    );

    await expect(
      new SessionPullRequestRefreshClient(sessions).requestRefresh("session-1")
    ).resolves.toBe("refreshing");

    expect(fetch).toHaveBeenCalledWith(
      "session-1",
      SessionInternalPaths.pullRequestsRefresh,
      { method: "POST", signal: expect.any(AbortSignal) },
      "?trigger=sweep"
    );
  });

  it("reports a missing session rather than throwing", async () => {
    const { sessions } = createSessions(
      Response.json({ error: "Session not found" }, { status: 404 })
    );

    await expect(
      new SessionPullRequestRefreshClient(sessions).requestRefresh("session-1")
    ).resolves.toBe("missing");
  });

  it("rejects any other non-ok response", async () => {
    const { sessions } = createSessions(new Response("nope", { status: 500 }));

    await expect(
      new SessionPullRequestRefreshClient(sessions).requestRefresh("session-1")
    ).rejects.toThrow("Pull request refresh failed with status 500");
  });
});
