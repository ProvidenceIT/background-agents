import { describe, expect, it } from "vitest";
import type { TurnLimit } from "@open-inspect/shared/types/sandbox-events";
import { describeScheduledContinue, describeTurnLimit, formatTimeUntil } from "./turn-limit";

const NOW_MS = Date.UTC(2026, 9, 22, 8, 56, 0);
const UTC = { locale: "en-GB", timeZone: "UTC" };

function limit(overrides: Partial<TurnLimit> = {}): TurnLimit {
  return {
    kind: "subscription_limit",
    window: "five_hour",
    resetsAtMs: Date.UTC(2026, 9, 22, 9, 0, 0),
    subscriptionSlot: "claude-5",
    harness: "claude",
    ...overrides,
  };
}

describe("describeTurnLimit", () => {
  it("names the window, the slot and the reset time with a countdown", () => {
    expect(describeTurnLimit(limit(), NOW_MS, UTC)).toEqual({
      summary: "Claude subscription limit reached (five-hour window, slot claude-5).",
      reset: "Resets at 09:00 (in 4 min).",
    });
  });

  it("says the limit has reset once the reset time has passed", () => {
    expect(describeTurnLimit(limit(), Date.UTC(2026, 9, 22, 9, 0, 1), UTC).reset).toBe(
      "The limit has reset."
    );
  });

  it("omits the reset sentence when the reset time is unknown", () => {
    expect(describeTurnLimit(limit({ resetsAtMs: null }), NOW_MS, UTC).reset).toBeNull();
  });

  it("drops the details for an unknown window without a slot", () => {
    expect(
      describeTurnLimit(limit({ window: "unknown", subscriptionSlot: null }), NOW_MS, UTC).summary
    ).toBe("Claude subscription limit reached.");
  });

  it("labels weekly windows and other harnesses", () => {
    expect(
      describeTurnLimit(
        limit({ window: "seven_day_opus", harness: "codex", subscriptionSlot: null }),
        NOW_MS,
        UTC
      ).summary
    ).toBe("ChatGPT subscription limit reached (weekly Opus window).");
  });

  it("adds the weekday when the reset is a day or more away", () => {
    expect(
      describeTurnLimit(limit({ resetsAtMs: Date.UTC(2026, 9, 24, 13, 30, 0) }), NOW_MS, UTC).reset
    ).toBe("Resets at Sat 13:30 (in 2 d 5 h).");
  });
});

describe("formatTimeUntil", () => {
  it.each([
    [30_000, "in less than a minute"],
    [60_000, "in 1 min"],
    [61_000, "in 2 min"],
    [60 * 60_000, "in 1 h"],
    [65 * 60_000, "in 1 h 5 min"],
    [24 * 60 * 60_000, "in 1 d"],
  ])("formats %i ms as %s", (remainingMs, expected) => {
    expect(formatTimeUntil(remainingMs)).toBe(expected);
  });
});

describe("describeScheduledContinue", () => {
  it("gives the time the continue is sent", () => {
    expect(describeScheduledContinue(Date.UTC(2026, 9, 22, 9, 1, 0), NOW_MS, UTC)).toBe(
      "Continues automatically at 09:01."
    );
  });

  it("adds the weekday when the continue is a day or more away", () => {
    expect(describeScheduledContinue(Date.UTC(2026, 9, 24, 13, 31, 0), NOW_MS, UTC)).toBe(
      "Continues automatically at Sat 13:31."
    );
  });
});
