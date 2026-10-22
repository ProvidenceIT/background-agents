import { describe, expect, it } from "vitest";
import { serverMessageSchema, sessionSnapshotStateSchema } from "./server-messages";
import {
  CONTINUE_AT_RESET_BUFFER_MS,
  CONTINUE_AT_RESET_PROMPT,
  continueAtResetResponseSchema,
  forkSessionRequestSchema,
  forkSubscriptionSlotsResponseSchema,
  NO_FUTURE_RESET,
  SUBSCRIPTION_SLOT_UNAVAILABLE,
} from "./session-api";

const sessionState = {
  id: "session-1",
  title: "Fix login",
  repoOwner: "acme",
  repoName: "widgets",
  baseBranch: "main",
  branchName: null,
  status: "active",
  sandboxStatus: "ready",
  messageCount: 3,
  createdAt: 1,
};

describe("fork onto a chosen subscription slot", () => {
  it("keeps a named subscriptionSlot", () => {
    expect(
      forkSessionRequestSchema.parse({
        forkRequestId: "req-12345678",
        subscriptionSlot: "claude-3",
      })
    ).toEqual({ forkRequestId: "req-12345678", subscriptionSlot: "claude-3" });
  });

  it("reads null and absence as automatic", () => {
    expect(
      forkSessionRequestSchema.parse({ forkRequestId: "req-12345678", subscriptionSlot: null })
        .subscriptionSlot
    ).toBeNull();
    expect(
      forkSessionRequestSchema.parse({ forkRequestId: "req-12345678" }).subscriptionSlot
    ).toBeUndefined();
  });

  it.each([
    ["a path", "../claude-1"],
    ["a blank name", ""],
    ["a name with a space", "claude 1"],
    ["a name over 64 characters", "c".repeat(65)],
  ])("rejects %s", (_label, subscriptionSlot) => {
    expect(
      forkSessionRequestSchema.safeParse({ forkRequestId: "req-12345678", subscriptionSlot })
        .success
    ).toBe(false);
  });

  it("lists slots with and without a known headroom", () => {
    const response = {
      harness: "claude",
      slots: [
        { slot: "claude-1", percentRemaining: 72, lastUsedAt: 1_790_000_000_000 },
        { slot: "claude-2", percentRemaining: null, lastUsedAt: null },
      ],
    };

    expect(forkSubscriptionSlotsResponseSchema.parse(response)).toEqual(response);
  });

  it("rejects a headroom outside 0 to 100", () => {
    expect(
      forkSubscriptionSlotsResponseSchema.safeParse({
        harness: "claude",
        slots: [{ slot: "claude-1", percentRemaining: 101, lastUsedAt: null }],
      }).success
    ).toBe(false);
  });

  it("names the refusal code", () => {
    expect(SUBSCRIPTION_SLOT_UNAVAILABLE).toBe("subscription_slot_unavailable");
  });
});

describe("continue when it resets", () => {
  it("fixes the buffer, the prompt and the refusal code", () => {
    expect(CONTINUE_AT_RESET_BUFFER_MS).toBe(60_000);
    expect(CONTINUE_AT_RESET_PROMPT).toBe("Continue where you stopped.");
    expect(NO_FUTURE_RESET).toBe("no_future_reset");
  });

  it("answers with the scheduled time or null", () => {
    expect(
      continueAtResetResponseSchema.parse({ scheduledContinueAtMs: 1_790_000_060_000 })
    ).toEqual({ scheduledContinueAtMs: 1_790_000_060_000 });
    expect(continueAtResetResponseSchema.parse({ scheduledContinueAtMs: null })).toEqual({
      scheduledContinueAtMs: null,
    });
    expect(continueAtResetResponseSchema.safeParse({}).success).toBe(false);
  });

  it("carries scheduledContinueAtMs on the snapshot", () => {
    expect(
      sessionSnapshotStateSchema.parse({
        ...sessionState,
        scheduledContinueAtMs: 1_790_000_060_000,
      }).scheduledContinueAtMs
    ).toBe(1_790_000_060_000);
    expect(
      sessionSnapshotStateSchema.parse({ ...sessionState, scheduledContinueAtMs: null })
        .scheduledContinueAtMs
    ).toBeNull();
    expect(sessionSnapshotStateSchema.parse(sessionState).scheduledContinueAtMs).toBeUndefined();
  });

  it("parses the scheduled_continue server message", () => {
    expect(
      serverMessageSchema.parse({ type: "scheduled_continue", scheduledContinueAtMs: null })
    ).toEqual({ type: "scheduled_continue", scheduledContinueAtMs: null });
    expect(
      serverMessageSchema.parse({
        type: "scheduled_continue",
        scheduledContinueAtMs: 1_790_000_060_000,
      })
    ).toEqual({ type: "scheduled_continue", scheduledContinueAtMs: 1_790_000_060_000 });
  });

  it("parses why a scheduled continue did not run, and rejects an unknown reason", () => {
    const failure = {
      reason: "refused",
      refusal: "usage_quota_exceeded",
      atMs: 1_790_000_060_000,
    };
    expect(
      serverMessageSchema.parse({
        type: "scheduled_continue",
        scheduledContinueAtMs: null,
        scheduledContinueFailure: failure,
      })
    ).toEqual({
      type: "scheduled_continue",
      scheduledContinueAtMs: null,
      scheduledContinueFailure: failure,
    });
    expect(
      serverMessageSchema.safeParse({
        type: "scheduled_continue",
        scheduledContinueAtMs: null,
        scheduledContinueFailure: { ...failure, reason: "lost" },
      }).success
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({
        type: "scheduled_continue",
        scheduledContinueAtMs: null,
        scheduledContinueFailure: { ...failure, refusal: "Usage quota reached: you used 812" },
      }).success
    ).toBe(false);
  });
});
