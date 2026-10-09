import { CODEX_SEAT } from "@open-inspect/shared/types/auth-homes";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { SandboxLaunchAdmission } from "../sandbox/lifecycle/manager";
import type { SandboxProvider } from "../sandbox/provider";
import {
  AUTH_HOME_LEASE_HEARTBEAT_INTERVAL_MS,
  AUTH_HOME_SEAT_POLL_MS,
  AuthHomeLeaseStore,
  codexClaimName,
  type AuthHomeSeatDecision,
} from "./lease";
import { UserAuthHomeStore } from "./store";

/**
 * One session's side of the Codex seat (see `lease.ts`), as the session
 * runtime uses it:
 *
 * - `admit` runs before every launch of a Codex session: the seat is taken,
 *   or the launch is refused with a "waiting for your Codex seat" reason and
 *   the session is asked to try again after `AUTH_HOME_SEAT_POLL_MS`; the
 *   prompt stays queued meanwhile;
 * - `poll` is that retry: when the session is still in a seat's queue it
 *   drives its prompt queue, which reaches `admit` again;
 * - `heartbeat` renews the seat while the sandbox is alive (the bridge's
 *   heartbeats, at most once per `AUTH_HOME_LEASE_HEARTBEAT_INTERVAL_MS`);
 * - `release` gives the seat up when the sandbox stops or fails.
 *
 * Sessions on any other harness pass straight through.
 */
export interface CodexSeatGate {
  admit(): Promise<SandboxLaunchAdmission>;
  poll(): Promise<void>;
  heartbeat(podName?: string | null): Promise<void>;
  release(): Promise<void>;
}

export interface CodexSeatGateDeps {
  db: SqlDatabase;
  getSessionId: () => string;
  /** The session's harness, from the runtime's own storage. */
  getHarness: () => string | null | undefined;
  provider: Pick<SandboxProvider, "authHomeClaimFence">;
  /** Arrange for `poll` to run at `at` (the session's alarm). */
  scheduleRetry: (at: number) => Promise<void>;
  /** Drive the session's prompt queue, which launches through `admit`. */
  driveQueue: () => Promise<void>;
  log: Logger;
  now?: () => number;
}

export const CODEX_PROVIDER_REQUIRED =
  "Codex sessions need a sandbox provider that mounts subscription homes (Kubernetes).";

/** The launch refusal a waiting session shows. */
export function codexSeatWaitMessage(
  decision: Extract<AuthHomeSeatDecision, { kind: "waiting" }>
): string {
  switch (decision.reason) {
    case "held":
      return `Waiting for your Codex seat: another Codex session is running on this subscription home (position ${decision.position} in the queue). This session starts when it ends.`;
    case "fencing":
      return "Waiting for your Codex seat: the Codex session that held it stopped responding, and its sandbox is being shut down first.";
    case "claim_mounted":
      return "Waiting for your Codex seat: a sandbox still has this home's Codex login mounted. This session starts once it is gone.";
  }
}

async function boundHome(db: SqlDatabase, sessionId: string) {
  const row = await db
    .prepare("SELECT auth_home_id FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ auth_home_id: string | null }>();
  return row?.auth_home_id ? new UserAuthHomeStore(db).getById(row.auth_home_id) : null;
}

export function createCodexSeatGate(deps: CodexSeatGateDeps): CodexSeatGate {
  const now = deps.now ?? Date.now;
  const leases = new AuthHomeLeaseStore(deps.db, now);
  const isCodex = () => deps.getHarness() === CODEX_SEAT;
  let lastHeartbeatAt = Number.NEGATIVE_INFINITY;

  return {
    async admit() {
      if (!isCodex()) return { admitted: true };
      const fence = deps.provider.authHomeClaimFence?.();
      if (!fence) return { admitted: false, reason: CODEX_PROVIDER_REQUIRED };
      const sessionId = deps.getSessionId();
      const home = await boundHome(deps.db, sessionId);
      // Unbound or gone: the mount lookup refuses the launch with the cause.
      if (!home) return { admitted: true };
      const decision = await leases.acquire(
        {
          homeId: home.id,
          provider: CODEX_SEAT,
          sessionId,
          claimName: codexClaimName(home.pvcName),
        },
        fence
      );
      if (decision.kind === "granted") {
        lastHeartbeatAt = now();
        deps.log.info("Codex seat granted", {
          event: "auth_home.seat_granted",
          auth_home_id: home.id,
        });
        return { admitted: true };
      }
      deps.log.info("Codex seat busy", {
        event: "auth_home.seat_waiting",
        auth_home_id: home.id,
        reason: decision.reason,
        position: decision.position,
        holder_session_id: decision.holderSessionId,
      });
      await deps.scheduleRetry(now() + AUTH_HOME_SEAT_POLL_MS);
      return { admitted: false, reason: codexSeatWaitMessage(decision) };
    },

    async poll() {
      if (!isCodex()) return;
      if (await leases.isWaiting(deps.getSessionId())) await deps.driveQueue();
    },

    async heartbeat(podName) {
      if (!isCodex()) return;
      const at = now();
      if (at - lastHeartbeatAt < AUTH_HOME_LEASE_HEARTBEAT_INTERVAL_MS) return;
      lastHeartbeatAt = at;
      const held = await leases.heartbeatSession(deps.getSessionId(), podName);
      if (!held) {
        // Fenced while silent: the pod is being deleted under the session.
        deps.log.warn("Codex seat heartbeat from a session that does not hold it", {
          event: "auth_home.seat_lost",
        });
      }
    },

    async release() {
      if (!isCodex()) return;
      const waiting = await leases.release(deps.getSessionId());
      lastHeartbeatAt = Number.NEGATIVE_INFINITY;
      deps.log.info("Codex seat released", {
        event: "auth_home.seat_released",
        waiting_sessions: waiting.length,
      });
    },
  };
}
