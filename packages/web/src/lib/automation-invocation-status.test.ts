import { describe, expect, it } from "vitest";
import { waitingForResetLabel } from "./automation-invocation-status";

describe("waitingForResetLabel", () => {
  it("names the resume time on a 24-hour clock", () => {
    expect(
      waitingForResetLabel(new Date("2026-07-01T14:05:00Z").getTime(), {
        locale: "en-GB",
        timeZone: "UTC",
      })
    ).toBe("Waiting for reset until 14:05");
  });

  it("follows the viewer's time zone", () => {
    expect(
      waitingForResetLabel(new Date("2026-07-01T14:05:00Z").getTime(), {
        locale: "en-GB",
        timeZone: "Europe/Amsterdam",
      })
    ).toBe("Waiting for reset until 16:05");
  });
});
