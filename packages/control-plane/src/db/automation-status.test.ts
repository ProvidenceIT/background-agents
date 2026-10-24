import { describe, expect, it } from "vitest";
import { deriveInvocationStatus } from "./automation-store";

describe("deriveInvocationStatus", () => {
  it("keeps repository authorization denials distinct from successful runs", () => {
    expect(
      deriveInvocationStatus({
        total: 1,
        starting: 0,
        active: 0,
        waiting: 0,
        failed: 0,
        completed: 0,
        skipped: 0,
        unauthorized: 1,
      })
    ).toBe("unauthorized");
  });

  it("keeps an invocation active until its running children finish", () => {
    expect(
      deriveInvocationStatus({
        total: 2,
        starting: 0,
        active: 1,
        waiting: 0,
        failed: 0,
        completed: 0,
        skipped: 0,
        unauthorized: 1,
      })
    ).toBe("running");
  });

  it("shows a waiting child once nothing is active, before any terminal outcome", () => {
    expect(
      deriveInvocationStatus({
        total: 2,
        starting: 0,
        active: 0,
        waiting: 1,
        failed: 1,
        completed: 0,
        skipped: 0,
        unauthorized: 0,
      })
    ).toBe("waiting_for_reset");
  });
});
