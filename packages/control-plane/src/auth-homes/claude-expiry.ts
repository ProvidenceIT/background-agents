import type { SandboxAuthHomeReport } from "@open-inspect/shared/types/sandbox-events";

/**
 * Timestamps below this are read as epoch seconds: 10^11 ms is March 1973,
 * while 10^11 s lies past the year 5000, so no real expiry is ambiguous.
 */
const EPOCH_SECONDS_BELOW = 1e11;
const DIGITS = /^\d+$/;

/**
 * The Claude token expiry a bridge reported for its mounted home, as epoch
 * milliseconds, or null when it reported none or something that is not a
 * timestamp. `claude/expires_at` is written by the enrolment script as ISO
 * 8601; an integer is accepted in seconds or milliseconds.
 */
export function reportedClaudeExpiresAt(
  report: Pick<SandboxAuthHomeReport, "claude_expires_at"> | undefined
): number | null {
  const raw = report?.claude_expires_at;
  if (raw === undefined || raw === null) return null;
  let epoch: number;
  if (typeof raw === "number") {
    epoch = raw;
  } else if (DIGITS.test(raw)) {
    epoch = Number(raw);
  } else {
    epoch = Date.parse(raw);
  }
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  const ms = epoch < EPOCH_SECONDS_BELOW ? epoch * 1000 : epoch;
  return Number.isSafeInteger(Math.round(ms)) ? Math.round(ms) : null;
}
