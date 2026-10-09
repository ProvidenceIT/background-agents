import type { SqlDatabase } from "../db/sql-database";

/**
 * The fenced Codex seat: one running Codex session per subscription home.
 *
 * Codex reads and refreshes the home's `auth.json` itself, and its refresh
 * token is single-use, so two sandboxes running Codex on one home would race
 * each other ("one auth.json per runner or per serialized workflow stream").
 * An in-pod file lock cannot serialize them: under gVisor each sandbox's
 * locks live in its own sentry. The control plane therefore holds the seat:
 *
 * - `acquire` grants the seat to a session, or queues it (FIFO) and reports
 *   why it waits;
 * - the holder heartbeats while its sandbox is alive (`AUTH_HOME_LEASE_
 *   HEARTBEAT_INTERVAL_MS`), and releases the seat when the sandbox stops;
 * - a holder silent for `AUTH_HOME_LEASE_EXPIRY_MS` is fenced: its pods are
 *   deleted, and the seat moves on only once no other session's pod mounts
 *   the claim any more (the API server is the witness, so a control-plane
 *   restart or a lost heartbeat cannot hand out a second seat while the
 *   first pod still runs);
 * - and the seat is never granted while any other session's pod mounts the
 *   claim, lease row or not.
 *
 * D1 has no interactive transactions, so each change is one conditional
 * statement: a grant is an insert that does nothing on conflict, read back;
 * a takeover deletes the stale row only if it is still the row that was read.
 */

/** The seat kind the lease serializes. `max_concurrent` for it is fixed at 1. */
export const CODEX_SEAT = "codex";

/** How often a holder's sandbox renews the seat. */
export const AUTH_HOME_LEASE_HEARTBEAT_INTERVAL_MS = 60_000;
/** A holder silent this long is fenced. */
export const AUTH_HOME_LEASE_EXPIRY_MS = 10 * 60_000;
/** How often a waiting session asks again. */
export const AUTH_HOME_SEAT_POLL_MS = 30_000;
/** A waiter that has not asked for this long has stopped waiting. */
export const AUTH_HOME_LEASE_QUEUE_STALE_MS = 4 * AUTH_HOME_SEAT_POLL_MS;

/** The claim a home's Codex login lives on: `sf-home-<u>` -> `sf-home-<u>-codex`. */
export function codexClaimName(homePvcName: string): string {
  return `${homePvcName}-${CODEX_SEAT}`;
}

/** A pod that mounts a home's claim, as the fence sees it. */
export interface AuthHomeClaimPod {
  name: string;
  uid?: string;
  /** The session the pod's sandbox belongs to, from its annotation. */
  sessionId: string | null;
  /** Deletion requested; the pod still holds the mount until it is gone. */
  terminating: boolean;
}

/** What fencing needs from the sandbox provider. */
export interface AuthHomeClaimFence {
  /** Every pod (terminating ones too) whose spec mounts the claim. */
  listPodsMountingClaim(claimName: string): Promise<AuthHomeClaimPod[]>;
  /** Request deletion; returning does not mean the pod is gone. */
  deletePod(pod: AuthHomeClaimPod): Promise<void>;
}

export interface AuthHomeSeat {
  homeId: string;
  provider: string;
  sessionId: string;
  podName: string | null;
  acquiredAt: number;
  heartbeatAt: number;
  fencedAt: number | null;
}

export type AuthHomeSeatWaitReason =
  /** Another session holds the seat and is alive, or is ahead in the queue. */
  | "held"
  /** The holder went silent; its pods are being deleted. */
  | "fencing"
  /** A pod of another session mounts the claim although nobody holds the seat. */
  | "claim_mounted";

export type AuthHomeSeatDecision =
  | { kind: "granted"; seat: AuthHomeSeat }
  | {
      kind: "waiting";
      reason: AuthHomeSeatWaitReason;
      /** 1-based place among live waiters. */
      position: number;
      holderSessionId: string | null;
    };

export interface AuthHomeSeatRequest {
  homeId: string;
  provider: string;
  sessionId: string;
  claimName: string;
}

export interface AuthHomeSeatWaiter {
  sessionId: string;
  position: number;
  enqueuedAt: number;
}

export interface AuthHomeSeatStatus {
  homeId: string;
  provider: string;
  holder: AuthHomeSeat | null;
  waiting: AuthHomeSeatWaiter[];
}

interface LeaseRow {
  home_id: string;
  provider: string;
  session_id: string;
  pod_name: string | null;
  acquired_at: number;
  heartbeat_at: number;
  fenced_at: number | null;
}

function toSeat(row: LeaseRow): AuthHomeSeat {
  return {
    homeId: row.home_id,
    provider: row.provider,
    sessionId: row.session_id,
    podName: row.pod_name,
    acquiredAt: Number(row.acquired_at),
    heartbeatAt: Number(row.heartbeat_at),
    fencedAt: row.fenced_at === null ? null : Number(row.fenced_at),
  };
}

export class AuthHomeLeaseStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly now: () => number = Date.now
  ) {}

  async get(homeId: string, provider: string): Promise<AuthHomeSeat | null> {
    const row = await this.db
      .prepare(
        `SELECT home_id, provider, session_id, pod_name, acquired_at, heartbeat_at, fenced_at
         FROM auth_home_leases WHERE home_id = ? AND provider = ?`
      )
      .bind(homeId, provider)
      .first<LeaseRow>();
    return row ? toSeat(row) : null;
  }

  /**
   * Grant the seat, or queue the session and say why it waits. Safe to call
   * again and again: a waiter's call refreshes its place, a holder's call
   * renews its heartbeat.
   */
  async acquire(
    request: AuthHomeSeatRequest,
    fence: AuthHomeClaimFence
  ): Promise<AuthHomeSeatDecision> {
    const { homeId, provider, sessionId } = request;
    const pods = await fence.listPodsMountingClaim(request.claimName);
    // The acquiring session's own pods are its previous generation, which
    // the launch replaces; every other pod is someone else's Codex.
    const foreign = pods.filter((pod) => pod.sessionId !== sessionId);
    const lease = await this.get(homeId, provider);

    if (lease && lease.sessionId === sessionId) {
      if (foreign.length > 0) return this.wait(request, "claim_mounted", sessionId);
      await this.heartbeat(request);
      await this.leaveQueue(sessionId, homeId, provider);
      return { kind: "granted", seat: (await this.get(homeId, provider)) ?? lease };
    }

    if (lease) {
      if (this.now() - lease.heartbeatAt < AUTH_HOME_LEASE_EXPIRY_MS) {
        return this.wait(request, "held", lease.sessionId);
      }
      if (foreign.length > 0) {
        await this.fence(lease, foreign, fence);
        return this.wait(request, "fencing", lease.sessionId);
      }
      // The silent holder's pods are gone from the API server: retire its
      // row, but only if it is still the row read above.
      await this.db
        .prepare(
          `DELETE FROM auth_home_leases
           WHERE home_id = ? AND provider = ? AND session_id = ? AND heartbeat_at = ?`
        )
        .bind(homeId, provider, lease.sessionId, lease.heartbeatAt)
        .run();
    } else if (foreign.length > 0) {
      return this.wait(request, "claim_mounted", null);
    }

    return this.grantInOrder(request);
  }

  /** Renew the holder's heartbeat; false when the session does not hold the seat. */
  async heartbeat(request: {
    homeId: string;
    provider: string;
    sessionId: string;
    podName?: string | null;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE auth_home_leases
         SET heartbeat_at = ?, fenced_at = NULL, pod_name = COALESCE(?, pod_name)
         WHERE home_id = ? AND provider = ? AND session_id = ?`
      )
      .bind(
        this.now(),
        request.podName ?? null,
        request.homeId,
        request.provider,
        request.sessionId
      )
      .run();
    return result.meta.changes > 0;
  }

  /** Renew every seat the session holds; false when it holds none. */
  async heartbeatSession(sessionId: string, podName?: string | null): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE auth_home_leases
         SET heartbeat_at = ?, fenced_at = NULL, pod_name = COALESCE(?, pod_name)
         WHERE session_id = ?`
      )
      .bind(this.now(), podName ?? null, sessionId)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Give up every seat the session holds and its places in every queue.
   * Returns the sessions still waiting on the seats it held, oldest first,
   * so the caller can tell them to ask again.
   */
  async release(sessionId: string): Promise<string[]> {
    const held = await this.db
      .prepare("SELECT home_id, provider FROM auth_home_leases WHERE session_id = ?")
      .bind(sessionId)
      .all<{ home_id: string; provider: string }>();
    await this.db.batch([
      this.db.prepare("DELETE FROM auth_home_leases WHERE session_id = ?").bind(sessionId),
      this.db.prepare("DELETE FROM auth_home_lease_queue WHERE session_id = ?").bind(sessionId),
    ]);
    const waiting: string[] = [];
    for (const seat of held.results ?? []) {
      for (const waiter of await this.liveWaiters(seat.home_id, seat.provider)) {
        waiting.push(waiter.sessionId);
      }
    }
    return waiting;
  }

  /** Whether the session is queued for any seat; a waiting session polls while it is. */
  async isWaiting(sessionId: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS waiting FROM auth_home_lease_queue WHERE session_id = ? LIMIT 1")
      .bind(sessionId)
      .first();
    return row !== null;
  }

  /** The holder and the live queue of each of the homes' seats of `provider`. */
  async status(homeIds: readonly string[], provider: string): Promise<AuthHomeSeatStatus[]> {
    const statuses: AuthHomeSeatStatus[] = [];
    for (const homeId of homeIds) {
      statuses.push({
        homeId,
        provider,
        holder: await this.get(homeId, provider),
        waiting: await this.liveWaiters(homeId, provider),
      });
    }
    return statuses;
  }

  private async fence(
    lease: AuthHomeSeat,
    pods: readonly AuthHomeClaimPod[],
    fence: AuthHomeClaimFence
  ): Promise<void> {
    for (const pod of pods) {
      if (!pod.terminating) await fence.deletePod(pod);
    }
    if (lease.fencedAt === null) {
      await this.db
        .prepare(
          `UPDATE auth_home_leases SET fenced_at = ?
           WHERE home_id = ? AND provider = ? AND session_id = ? AND fenced_at IS NULL`
        )
        .bind(this.now(), lease.homeId, lease.provider, lease.sessionId)
        .run();
    }
  }

  private async grantInOrder(request: AuthHomeSeatRequest): Promise<AuthHomeSeatDecision> {
    const { homeId, provider, sessionId } = request;
    await this.joinQueue(request);
    const waiters = await this.liveWaiters(homeId, provider);
    const head = waiters[0];
    if (head && head.sessionId !== sessionId) {
      return this.waitingAt(waiters, sessionId, "held", null);
    }
    const now = this.now();
    await this.db
      .prepare(
        `INSERT INTO auth_home_leases
           (home_id, provider, session_id, pod_name, acquired_at, heartbeat_at, fenced_at)
         VALUES (?, ?, ?, NULL, ?, ?, NULL)
         ON CONFLICT (home_id, provider) DO NOTHING`
      )
      .bind(homeId, provider, sessionId, now, now)
      .run();
    const seat = await this.get(homeId, provider);
    if (!seat || seat.sessionId !== sessionId) {
      // Another session won the insert between our read and our write.
      return this.wait(request, "held", seat?.sessionId ?? null);
    }
    await this.leaveQueue(sessionId, homeId, provider);
    return { kind: "granted", seat };
  }

  private async wait(
    request: AuthHomeSeatRequest,
    reason: AuthHomeSeatWaitReason,
    holderSessionId: string | null
  ): Promise<AuthHomeSeatDecision> {
    await this.joinQueue(request);
    const waiters = await this.liveWaiters(request.homeId, request.provider);
    return this.waitingAt(waiters, request.sessionId, reason, holderSessionId);
  }

  private waitingAt(
    waiters: readonly AuthHomeSeatWaiter[],
    sessionId: string,
    reason: AuthHomeSeatWaitReason,
    holderSessionId: string | null
  ): AuthHomeSeatDecision {
    const mine = waiters.find((waiter) => waiter.sessionId === sessionId);
    return {
      kind: "waiting",
      reason,
      position: mine?.position ?? waiters.length + 1,
      holderSessionId,
    };
  }

  private async joinQueue(request: AuthHomeSeatRequest): Promise<void> {
    const now = this.now();
    await this.db
      .prepare(
        `INSERT INTO auth_home_lease_queue (home_id, provider, session_id, enqueued_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (home_id, provider, session_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
      )
      .bind(request.homeId, request.provider, request.sessionId, now, now)
      .run();
  }

  private async leaveQueue(sessionId: string, homeId: string, provider: string): Promise<void> {
    await this.db
      .prepare(
        "DELETE FROM auth_home_lease_queue WHERE home_id = ? AND provider = ? AND session_id = ?"
      )
      .bind(homeId, provider, sessionId)
      .run();
  }

  /** Waiters that asked recently, oldest first. Stale entries are dropped on the way. */
  private async liveWaiters(homeId: string, provider: string): Promise<AuthHomeSeatWaiter[]> {
    const staleBefore = this.now() - AUTH_HOME_LEASE_QUEUE_STALE_MS;
    await this.db
      .prepare(
        "DELETE FROM auth_home_lease_queue WHERE home_id = ? AND provider = ? AND last_seen_at < ?"
      )
      .bind(homeId, provider, staleBefore)
      .run();
    const rows = await this.db
      .prepare(
        `SELECT session_id, enqueued_at FROM auth_home_lease_queue
         WHERE home_id = ? AND provider = ?
         ORDER BY enqueued_at, session_id`
      )
      .bind(homeId, provider)
      .all<{ session_id: string; enqueued_at: number }>();
    return (rows.results ?? []).map((row, index) => ({
      sessionId: row.session_id,
      position: index + 1,
      enqueuedAt: Number(row.enqueued_at),
    }));
  }
}
