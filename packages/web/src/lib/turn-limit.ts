import type { TurnLimit, TurnLimitWindow } from "@open-inspect/shared/types/sandbox-events";
import type {
  ScheduledContinueFailure,
  ScheduledContinueRefusal,
} from "@open-inspect/shared/types/server-messages";

/** The prompt the banner's Continue button sends through the ordinary prompt path. */
export const CONTINUE_AFTER_LIMIT_PROMPT = "Continue where you stopped.";

const WINDOW_LABELS: Record<TurnLimitWindow, string | null> = {
  five_hour: "five-hour window",
  seven_day: "weekly window",
  seven_day_opus: "weekly Opus window",
  seven_day_sonnet: "weekly Sonnet window",
  overage: "extra usage",
  unknown: null,
};

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "ChatGPT",
  opencode: "OpenCode",
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface TurnLimitDescription {
  /** What was hit, e.g. "Claude subscription limit reached (five-hour window, slot claude-5)." */
  summary: string;
  /** When it resets; null when the reset time is unknown. */
  reset: string | null;
}

export interface TurnLimitFormatOptions {
  locale?: string;
  timeZone?: string;
}

/**
 * Remaining time as the banner phrases it. Minutes round up so the countdown never claims the
 * limit has reset early.
 */
export function formatTimeUntil(remainingMs: number): string {
  if (remainingMs < MINUTE_MS) return "in less than a minute";
  const totalMinutes = Math.ceil(remainingMs / MINUTE_MS);
  if (totalMinutes < 60) return `in ${totalMinutes} min`;
  if (remainingMs < DAY_MS) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `in ${hours} h` : `in ${hours} h ${minutes} min`;
  }
  const totalHours = Math.ceil(remainingMs / HOUR_MS);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `in ${days} d` : `in ${days} d ${hours} h`;
}

function formatLimitClock(atMs: number, nowMs: number, options: TurnLimitFormatOptions) {
  const sameDay = atMs - nowMs < DAY_MS;
  return new Intl.DateTimeFormat(options.locale, {
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: options.timeZone,
  }).format(atMs);
}

/** What was hit; unlike the reset, it does not depend on the clock or time zone. */
export function turnLimitSummary(limit: TurnLimit): string {
  const provider = PROVIDER_LABELS[limit.harness] ?? limit.harness;
  const details = [
    WINDOW_LABELS[limit.window],
    limit.subscriptionSlot ? `slot ${limit.subscriptionSlot}` : null,
  ].filter((part): part is string => part !== null);
  return `${provider} subscription limit reached${details.length ? ` (${details.join(", ")})` : ""}.`;
}

export function describeTurnLimit(
  limit: TurnLimit,
  nowMs: number,
  options: TurnLimitFormatOptions = {}
): TurnLimitDescription {
  const summary = turnLimitSummary(limit);

  if (limit.resetsAtMs === null) return { summary, reset: null };
  if (limit.resetsAtMs <= nowMs) return { summary, reset: "The limit has reset." };
  const clock = formatLimitClock(limit.resetsAtMs, nowMs, options);
  return {
    summary,
    reset: `Resets at ${clock} (${formatTimeUntil(limit.resetsAtMs - nowMs)}).`,
  };
}

/** When an opted-in continue will be sent, on the same clock as the reset. */
export function describeScheduledContinue(
  scheduledContinueAtMs: number,
  nowMs: number,
  options: TurnLimitFormatOptions = {}
): string {
  return `Continues automatically at ${formatLimitClock(scheduledContinueAtMs, nowMs, options)}.`;
}

/** Shown to every viewer, so it names the kind of refusal and no one's usage figures. */
function describeRefusal(refusal: ScheduledContinueRefusal | null): string {
  switch (refusal) {
    case "usage_quota_exceeded":
      return "the person who scheduled it has reached a usage quota.";
    case "auth_home_refused":
      return "the subscription that runs this session refused the turn.";
    case "budget_exhausted":
      return "the session cost limit was reached.";
    case "session_not_promptable":
      return "the session can no longer take prompts.";
    case "queue_full":
      return "the session's prompt queue was full.";
    case "request_conflict":
      return "its prompt clashed with another request.";
    case "harness_model_incompatible":
      return "the session's model no longer works with its agent.";
    case null:
      return "its prompt was refused.";
  }
}

/** Why the opted-in continue did not run when it was due. */
export function describeScheduledContinueFailure(failure: ScheduledContinueFailure): string {
  switch (failure.reason) {
    case "refused":
      return `The scheduled continue did not run: ${describeRefusal(failure.refusal)}`;
    case "requester_cannot_collaborate":
      return "The scheduled continue did not run: the person who scheduled it can no longer work in this session.";
    case "retries_exhausted":
      return "The scheduled continue did not run: the session could not queue it.";
  }
}
