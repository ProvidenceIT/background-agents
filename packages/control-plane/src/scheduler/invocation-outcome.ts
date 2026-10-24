/**
 * Outcome contract of a single automation firing, shared by the scheduler and
 * the per-source admission pipelines that drive it (e.g. GitHub admission).
 */

import type { TurnLimit } from "@open-inspect/shared/types/sandbox-events";
import type { AutomationRunRow } from "../db/automation-store";

/**
 * Why a run's session stopped short of success when the cause is not the
 * automation's own work. Stored on `automation_runs.outcome`; null for an
 * ordinary success or failure.
 */
export type AutomationRunOutcome = "usage_limited" | "overloaded";

/**
 * Outcomes that never count toward the consecutive-failure auto-pause. The
 * strike counter (`STRIKE_FAILED_RUN_SQL`) reads this set; later outcome
 * classes join it here rather than adding their own exception.
 */
export const NON_STRIKE_OUTCOMES: ReadonlySet<AutomationRunOutcome> = new Set([
  "usage_limited",
  "overloaded",
]);

/**
 * SQL predicate over an `automation_runs` row that is true when the row is a
 * failure that counts as a strike. Built from NON_STRIKE_OUTCOMES, whose
 * members are fixed literals, so nothing user-supplied reaches the SQL text.
 */
export const STRIKE_FAILED_RUN_SQL = `(status = 'failed' AND (outcome IS NULL OR outcome NOT IN (${[
  ...NON_STRIKE_OUTCOMES,
]
  .map((outcome) => `'${outcome}'`)
  .join(", ")})))`;

/** Provider "overloaded" errors (Anthropic's 529 `overloaded_error` and its text). */
const OVERLOADED_ERROR = /overloaded|\b529\b/i;

/** Classify a failed turn's end; null when it is an ordinary failure. */
export function classifyRunFailure(failure: {
  error?: string;
  limit?: TurnLimit | null;
}): AutomationRunOutcome | null {
  if (failure.limit) return "usage_limited";
  if (failure.error && OVERLOADED_ERROR.test(failure.error)) return "overloaded";
  return null;
}

/** Retries an overloaded run gets before it fails for good. */
const OVERLOADED_MAX_RETRIES = 3;

/** Wait before the first overloaded retry; each later retry doubles it. */
const OVERLOADED_RETRY_BASE_MS = 60_000;

/** When the next overloaded retry is due, or null once the retries are spent. */
export function overloadedRetryDelayMs(retriesSoFar: number): number | null {
  if (retriesSoFar >= OVERLOADED_MAX_RETRIES) return null;
  return OVERLOADED_RETRY_BASE_MS * 2 ** retriesSoFar;
}

/** Why a firing was refused without recording an invocation. */
export type AutomationTriggerBlockedReason = "concurrent_run_active" | "team_grants_changed";

export type StartInvocationResult =
  /** Invocation inserted; children launched (some may have pre-failed or been denied). */
  | { outcome: "started"; invocationId: string; runs: AutomationRunRow[]; launched: number }
  /**
   * Overlap — a childless skipped invocation was recorded (schedule/event);
   * null when a concurrent schedule firing already recorded this slot.
   */
  | { outcome: "skipped"; invocationId: string | null }
  /**
   * Overlap on a manual firing, or team grants changed during admission — nothing
   * recorded; manual callers answer 409.
   */
  | { outcome: "blocked"; reason: AutomationTriggerBlockedReason }
  /**
   * Idempotency/dedup collision — another firing owns this slot or event. Carries
   * the owning invocation for event dedup (trigger_key); null for schedule slots.
   */
  | { outcome: "deduplicated"; invocationId: string | null }
  /** The execution principal cannot launch the immutable target snapshot. */
  | { outcome: "unauthorized"; reason?: string };

/** The invocation that represents a firing, if one was recorded or already owned the event. */
export function firingInvocationId(result: StartInvocationResult): string | null {
  return "invocationId" in result ? result.invocationId : null;
}
