import type { TurnLimit, TurnLimitWindow } from "@open-inspect/shared/types/sandbox-events";

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

function formatResetClock(resetsAtMs: number, nowMs: number, options: TurnLimitFormatOptions) {
  const sameDay = resetsAtMs - nowMs < DAY_MS;
  return new Intl.DateTimeFormat(options.locale, {
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: options.timeZone,
  }).format(resetsAtMs);
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
  const clock = formatResetClock(limit.resetsAtMs, nowMs, options);
  return {
    summary,
    reset: `Resets at ${clock} (${formatTimeUntil(limit.resetsAtMs - nowMs)}).`,
  };
}
