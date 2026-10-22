import {
  CONTINUE_AT_RESET_BUFFER_MS,
  CONTINUE_AT_RESET_PROMPT,
} from "@open-inspect/shared/types/session-api";
import type { ScheduledContinueFailure } from "@open-inspect/shared/types/server-messages";
import { AuthHomeTurnRefusedError } from "../auth-homes/turn-admission";
import { UsageQuotaExceededError } from "../authorization/usage-quotas";
import type { Logger } from "../logger";
import type { AlarmScheduler } from "../platform-ports";
import type { EnqueuePromptRequest } from "./enqueue-prompt-contract";
import {
  BudgetExhaustedError,
  HarnessModelIncompatibleError,
  PromptQueueFullError,
  PromptRequestConflictError,
  SessionNotPromptableError,
} from "./message-queue";
import type { MessageRepository } from "./message-repository";
import type { SessionMessenger } from "./messenger";
import type { ScheduledContinue, SessionCoreRepository } from "./session-core-repository";

/**
 * How long a due continue waits before trying again after a passing failure: authorization
 * that cannot be read, or an enqueue that failed for any reason but a refusal.
 */
export const CONTINUE_AT_RESET_RETRY_MS = 60_000;

/** How many such retries a due continue gets before it is dropped. */
export const CONTINUE_AT_RESET_MAX_RETRIES = 30;

/** Enqueue failures that answer the same on a retry: the continue is dropped, not retried. */
function isLastingRefusal(error: unknown): boolean {
  return (
    error instanceof AuthHomeTurnRefusedError ||
    error instanceof UsageQuotaExceededError ||
    error instanceof BudgetExhaustedError ||
    error instanceof SessionNotPromptableError ||
    error instanceof PromptQueueFullError ||
    error instanceof PromptRequestConflictError ||
    error instanceof HarnessModelIncompatibleError
  );
}

export type ScheduleContinueOutcome =
  | { kind: "scheduled"; atMs: number }
  /** The last turn hit no limit, or its reset is unknown or already past. */
  | { kind: "no_future_reset" };

export interface ScheduledContinueDeps {
  repository: Pick<
    SessionCoreRepository,
    | "getScheduledContinue"
    | "setScheduledContinue"
    | "getScheduledContinueFailure"
    | "setScheduledContinueFailure"
    | "getLastTurnLimit"
    | "getSession"
  >;
  messageRepository: Pick<MessageRepository, "getPendingOrProcessingCount">;
  alarmScheduler: Pick<AlarmScheduler, "schedule">;
  messenger: Pick<SessionMessenger, "broadcast">;
  /** The session's own collaborate check for a user with no socket. */
  authorizeUser: (
    userId: string,
    action: "collaborate"
  ) => Promise<"allowed" | "denied" | "unavailable">;
  /** The API enqueue path: turn admission on the home, then the queue. */
  enqueuePrompt: (request: EnqueuePromptRequest) => Promise<unknown>;
  now: () => number;
  log: Logger;
}

/**
 * "Continue when it resets": one opted-in prompt per session, enqueued as the person
 * who asked once the last turn's limit window reopens. Persisted on the session row
 * and woken by the session's shared alarm, so it survives a restart. Any other
 * prompt, a new turn result, or closing the session drops it. When it is due but
 * cannot run (refused, the requester lost access, retries spent), the reason is
 * kept for the session view until the session moves on.
 */
export class SessionScheduledContinue {
  constructor(private readonly deps: ScheduledContinueDeps) {}

  /** When the session continues on its own, or null. */
  atMs(): number | null {
    return this.deps.repository.getScheduledContinue()?.atMs ?? null;
  }

  /** Schedule (or replace) the continue for the current limit's reset. */
  async schedule(requester: {
    requestedByUserId: string;
    authorId: string;
  }): Promise<ScheduleContinueOutcome> {
    const now = this.deps.now();
    const resetsAtMs = this.deps.repository.getLastTurnLimit()?.resetsAtMs ?? null;
    if (resetsAtMs === null || resetsAtMs <= now) return { kind: "no_future_reset" };
    const schedule: ScheduledContinue = {
      atMs: resetsAtMs + CONTINUE_AT_RESET_BUFFER_MS,
      requestedByUserId: requester.requestedByUserId,
      authorId: requester.authorId,
      createdAtMs: now,
    };
    this.store(schedule);
    await this.arm(schedule.atMs);
    this.deps.log.info("scheduled_continue.set", {
      event: "scheduled_continue.set",
      at_ms: schedule.atMs,
      requested_by_user_id: schedule.requestedByUserId,
    });
    return { kind: "scheduled", atMs: schedule.atMs };
  }

  /** Cancel at the user's request; answers the same whether or not one was scheduled. */
  cancel(): void {
    this.store(null);
  }

  /** Drop the schedule and any failure because something else moved the session on. */
  clear(reason: string): void {
    const { repository } = this.deps;
    if (!repository.getScheduledContinue() && !repository.getScheduledContinueFailure()) return;
    this.store(null);
    this.deps.log.info("scheduled_continue.cleared", {
      event: "scheduled_continue.cleared",
      reason,
    });
  }

  /** Re-arm the alarm after the runtime restarts. */
  async rearm(): Promise<void> {
    const schedule = this.deps.repository.getScheduledContinue();
    if (schedule) await this.arm(schedule.atMs);
  }

  /** Alarm delivery: enqueue the continue when it is due and still wanted. */
  async fireIfDue(): Promise<void> {
    const schedule = this.deps.repository.getScheduledContinue();
    if (!schedule) return;
    if (schedule.atMs > this.deps.now()) {
      await this.arm(schedule.atMs);
      return;
    }
    const blocked = this.blockedReason();
    if (blocked) {
      this.drop(schedule, blocked);
      return;
    }
    const authorization = await this.deps.authorizeUser(schedule.requestedByUserId, "collaborate");
    // A cancel, a replacement or a manual prompt may have landed during the await.
    const current = this.deps.repository.getScheduledContinue();
    if (!current || current.createdAtMs !== schedule.createdAtMs) return;
    if (authorization === "unavailable") {
      await this.retry(current, "authorization_unavailable");
      return;
    }
    if (authorization === "denied") {
      this.drop(current, "requester_cannot_collaborate", {
        reason: "requester_cannot_collaborate",
        detail: null,
      });
      return;
    }
    const blockedAfterAuthorization = this.blockedReason();
    if (blockedAfterAuthorization) {
      this.drop(current, blockedAfterAuthorization);
      return;
    }

    this.store(null);
    try {
      await this.deps.enqueuePrompt({
        turn: {
          triggerKind: "prompt",
          channel: "prompt",
          requestId: `continue-at-reset:${current.createdAtMs}`,
        },
        content: CONTINUE_AT_RESET_PROMPT,
        authorId: current.authorId,
        canonicalUserId: current.requestedByUserId,
        source: "web",
      });
      this.deps.log.info("scheduled_continue.fired", {
        event: "scheduled_continue.fired",
        requested_by_user_id: current.requestedByUserId,
      });
    } catch (error) {
      if (isLastingRefusal(error)) {
        this.deps.log.warn("scheduled_continue.refused", {
          event: "scheduled_continue.refused",
          requested_by_user_id: current.requestedByUserId,
          error: error instanceof Error ? error : String(error),
        });
        // Refusals carry the message the prompt routes show the user.
        if (!this.deps.repository.getScheduledContinue()) {
          this.store(null, { reason: "refused", detail: (error as Error).message });
        }
        return;
      }
      this.deps.log.warn("scheduled_continue.enqueue_failed", {
        event: "scheduled_continue.enqueue_failed",
        requested_by_user_id: current.requestedByUserId,
        error: error instanceof Error ? error : String(error),
      });
      // Restore only while nothing else has moved the session on during the enqueue.
      if (this.deps.repository.getScheduledContinue() || this.blockedReason()) return;
      await this.retry(current, "enqueue_failed");
    }
  }

  /** Try a due continue again later, or drop it once its retries are spent. */
  private async retry(schedule: ScheduledContinue, reason: string): Promise<void> {
    const retries = (schedule.retries ?? 0) + 1;
    if (retries > CONTINUE_AT_RESET_MAX_RETRIES) {
      this.drop(schedule, `${reason}_retries_exhausted`, {
        reason: "retries_exhausted",
        detail: null,
      });
      return;
    }
    const retryAtMs = this.deps.now() + CONTINUE_AT_RESET_RETRY_MS;
    this.store({ ...schedule, atMs: retryAtMs, retries });
    await this.arm(retryAtMs);
    this.deps.log.warn("scheduled_continue.retry", {
      event: "scheduled_continue.retry",
      reason,
      retries,
      retry_at_ms: retryAtMs,
    });
  }

  /** Why a due continue must not run now, or null when it may. */
  private blockedReason(): string | null {
    const status = this.deps.repository.getSession()?.status;
    if (status === undefined || status === "archived" || status === "cancelled") {
      return "session_closed";
    }
    if (!this.deps.repository.getLastTurnLimit()) return "limit_cleared";
    if (this.deps.messageRepository.getPendingOrProcessingCount() > 0) return "session_busy";
    return null;
  }

  private drop(
    schedule: ScheduledContinue,
    reason: string,
    failure?: Omit<ScheduledContinueFailure, "atMs">
  ): void {
    this.store(null, failure);
    this.deps.log.info("scheduled_continue.dropped", {
      event: "scheduled_continue.dropped",
      reason,
      requested_by_user_id: schedule.requestedByUserId,
    });
  }

  /** Persist and announce the schedule; setting or clearing it also replaces the failure. */
  private store(
    schedule: ScheduledContinue | null,
    failure?: Omit<ScheduledContinueFailure, "atMs">
  ): void {
    const storedFailure = failure ? { ...failure, atMs: this.deps.now() } : null;
    this.deps.repository.setScheduledContinue(schedule);
    this.deps.repository.setScheduledContinueFailure(storedFailure);
    this.deps.messenger.broadcast({
      type: "scheduled_continue",
      scheduledContinueAtMs: schedule?.atMs ?? null,
      scheduledContinueFailure: storedFailure,
    });
  }

  /** The schedule is persisted first, so a failed arm is recovered by `rearm` or the next alarm. */
  private async arm(atMs: number): Promise<void> {
    try {
      await this.deps.alarmScheduler.schedule(atMs);
    } catch (error) {
      this.deps.log.warn("scheduled_continue.arm_failed", {
        event: "scheduled_continue.arm_failed",
        at_ms: atMs,
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}
