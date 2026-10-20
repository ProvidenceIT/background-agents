/**
 * Periodic re-read of pull requests the D1 authority still holds as open.
 *
 * A PR's lifecycle state is otherwise kept current by the provider's
 * `pull_request` webhook and by the read-through refresh, which runs only when
 * someone opens the session or asks for a sync. A missed webhook on a session
 * nobody opens therefore left the record `open` indefinitely. This sweep asks
 * each such session to run that same read-through, so every write still goes
 * through the authority-then-mirror sequence in `pull-request-refresh.ts`.
 */

import { SessionInternalPaths } from "./contracts";
import type { Logger } from "../logger";
import type { SessionRuntimeClient } from "./runtime-client";

/**
 * The least time between two sweep attempts on one session. Kept well under
 * the cron's 15-minute period: runs start at slot time plus a variable delay,
 * so an interval equal to the period would skip a session whenever a run
 * starts less late than the one that stamped it. Each attempt costs one
 * provider read per PR artifact the session holds, merged and closed included.
 */
const OPEN_PULL_REQUEST_RECHECK_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Max sessions asked to refresh per sweep (backpressure). Each costs one
 * subrequest to its Durable Object here; the provider reads happen in that
 * Durable Object's own background task, outside this invocation's budget.
 */
const OPEN_PULL_REQUEST_SWEEP_LIMIT = 25;

/**
 * Bound on a single refresh request. The route answers before any provider
 * read, so this only has to cover waking the Durable Object; an abort is
 * counted as errored and the session waits its turn again.
 */
const OPEN_PULL_REQUEST_REFRESH_TIMEOUT_MS = 10_000;

/**
 * Own cron, every 15 minutes, offset from the other control-plane crons so no
 * two fire together.
 */
export const OPEN_PULL_REQUEST_SWEEP_CRON = "4,19,34,49 * * * *";

/** The D1 access the sweep needs; `SessionPullRequestStore` satisfies it. */
export interface OpenPullRequestIndex {
  listOpenPullRequestSessionIdsForSweep(staleBefore: number, limit: number): Promise<string[]>;
  markSweepAttempted(sessionIds: readonly string[], now: number): Promise<void>;
}

/** `missing`: the runtime answered 404, so no session exists behind the rows. */
export type PullRequestRefreshOutcome = "refreshing" | "missing";

/** Asks one session to re-read its pull requests from the provider. */
export interface PullRequestRefreshClient {
  requestRefresh(sessionId: string): Promise<PullRequestRefreshOutcome>;
}

export interface OpenPullRequestSweepResult {
  candidates: number;
  /** The session accepted the refresh; its outcome is logged by the session. */
  refreshing: number;
  missing: number;
  errored: number;
  /** The query is capped, so a full batch means more remain for the next sweep. */
  truncated: boolean;
}

/** Calls a session runtime's refresh route. */
export class SessionPullRequestRefreshClient implements PullRequestRefreshClient {
  constructor(private readonly sessions: SessionRuntimeClient) {}

  async requestRefresh(sessionId: string): Promise<PullRequestRefreshOutcome> {
    const response = await this.sessions.fetch(
      sessionId,
      SessionInternalPaths.pullRequestsRefresh,
      { method: "POST", signal: AbortSignal.timeout(OPEN_PULL_REQUEST_REFRESH_TIMEOUT_MS) },
      "?trigger=sweep"
    );

    if (response.status === 404) {
      return "missing";
    }

    if (!response.ok) {
      throw new Error(`Pull request refresh failed with status ${response.status}`);
    }

    return "refreshing";
  }
}

export class OpenPullRequestSweep {
  constructor(
    private readonly index: OpenPullRequestIndex,
    private readonly client: PullRequestRefreshClient,
    private readonly log: Logger,
    private readonly recheckIntervalMs: number = OPEN_PULL_REQUEST_RECHECK_INTERVAL_MS,
    private readonly limit: number = OPEN_PULL_REQUEST_SWEEP_LIMIT
  ) {}

  /**
   * The batch is stamped before any session is asked, so the stamp records an
   * attempt rather than a success. A session whose refresh fails, or whose
   * provider read fails inside the session, has already moved to the back of
   * the queue; there is no separate back-off. If the stamp write itself fails
   * the sweep stops, since dispatching unstamped would read the same batch on
   * every run.
   */
  async run(now: number): Promise<OpenPullRequestSweepResult> {
    const empty: OpenPullRequestSweepResult = {
      candidates: 0,
      refreshing: 0,
      missing: 0,
      errored: 0,
      truncated: false,
    };

    let candidates: string[];
    try {
      candidates = await this.index.listOpenPullRequestSessionIdsForSweep(
        now - this.recheckIntervalMs,
        this.limit
      );
      if (candidates.length === 0) return empty;
      await this.index.markSweepAttempted(candidates, now);
    } catch (error) {
      this.log.error("Open pull request sweep failed to read or stamp candidates", {
        event: "scheduler.open_pull_request_sweep_query_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }

    const outcomes = await Promise.allSettled(
      candidates.map((sessionId) => this.client.requestRefresh(sessionId))
    );

    const result: OpenPullRequestSweepResult = {
      candidates: candidates.length,
      refreshing: 0,
      missing: 0,
      errored: 0,
      truncated: candidates.length === this.limit,
    };

    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === "rejected") {
        result.errored += 1;
        this.log.warn("Open pull request refresh request failed", {
          event: "scheduler.open_pull_request_refresh_failed",
          session_id: candidates[index],
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
      } else if (outcome.value === "refreshing") {
        result.refreshing += 1;
      } else {
        result.missing += 1;
      }
    }

    this.log.info("Open pull request sweep completed", {
      event: "scheduler.open_pull_request_sweep",
      candidates: result.candidates,
      refreshing: result.refreshing,
      missing: result.missing,
      errored: result.errored,
      truncated: result.truncated,
    });

    return result;
  }
}
