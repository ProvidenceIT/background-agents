import { describe, expect, it } from "vitest";
import { sandboxEventSchema, turnLimitSchema } from "./sandbox-events";
import { sessionSnapshotStateSchema } from "./server-messages";
import {
  FORK_HANDOFF_MAX_CHARS,
  forkHandoffResponseSchema,
  forkSessionRequestSchema,
  forkSessionResponseSchema,
} from "./session-api";

const limit = {
  kind: "subscription_limit",
  window: "five_hour",
  resetsAtMs: 1_790_000_000_000,
  subscriptionSlot: "claude-5",
  harness: "claude",
} as const;

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

describe("TurnLimit on execution_complete", () => {
  it("keeps the limit of a failed turn", () => {
    const parsed = sandboxEventSchema.parse({
      type: "execution_complete",
      messageId: "message-1",
      success: false,
      error: "rate limited",
      sandboxId: "sandbox-1",
      timestamp: 123,
      limit,
    });

    expect(parsed).toMatchObject({ type: "execution_complete", limit });
  });

  it("accepts an unknown window and a missing reset time", () => {
    expect(
      turnLimitSchema.parse({
        ...limit,
        window: "unknown",
        resetsAtMs: null,
        subscriptionSlot: null,
      })
    ).toEqual({
      kind: "subscription_limit",
      window: "unknown",
      resetsAtMs: null,
      subscriptionSlot: null,
      harness: "claude",
    });
  });

  it("rejects a window the contract does not name", () => {
    expect(turnLimitSchema.safeParse({ ...limit, window: "daily" }).success).toBe(false);
  });
});

describe("session snapshot fork and limit fields", () => {
  it("carries lastTurnLimit and forkedFromSessionId", () => {
    const parsed = sessionSnapshotStateSchema.parse({
      ...sessionState,
      lastTurnLimit: limit,
      forkedFromSessionId: "session-0",
    });

    expect(parsed.lastTurnLimit).toEqual(limit);
    expect(parsed.forkedFromSessionId).toBe("session-0");
  });

  it("leaves both fields absent for a producer that predates them", () => {
    const parsed = sessionSnapshotStateSchema.parse(sessionState);

    expect(parsed.lastTurnLimit).toBeUndefined();
    expect(parsed.forkedFromSessionId).toBeUndefined();
  });
});

describe("fork API contracts", () => {
  it("parses a full fork request", () => {
    const body = {
      forkRequestId: "3f2b9c1e-7a4d-4e8b-9c1f-2a3b4c5d6e7f",
      handoff: "# Handoff\nContinue the login fix.",
      harness: "codex",
      model: "openai/gpt-5.4",
      reasoningEffort: "high",
      title: "Fix login (fork)",
    };

    expect(forkSessionRequestSchema.parse(body)).toEqual(body);
  });

  it("requires a forkRequestId and nothing else", () => {
    expect(forkSessionRequestSchema.parse({ forkRequestId: "req-12345678" })).toEqual({
      forkRequestId: "req-12345678",
    });
    expect(forkSessionRequestSchema.safeParse({}).success).toBe(false);
  });

  it.each([
    ["a too-short forkRequestId", { forkRequestId: "short" }],
    ["a blank handoff", { forkRequestId: "req-12345678", handoff: "   " }],
    ["an unknown harness", { forkRequestId: "req-12345678", harness: "gemini" }],
    ["an unknown field", { forkRequestId: "req-12345678", carry: "handoff" }],
  ])("rejects %s", (_label, body) => {
    expect(forkSessionRequestSchema.safeParse(body).success).toBe(false);
  });

  it("parses the fork response", () => {
    const response = { sessionId: "session-2", forkedFromSessionId: "session-1", created: false };

    expect(forkSessionResponseSchema.parse(response)).toEqual(response);
  });

  it("bounds the handoff draft at FORK_HANDOFF_MAX_CHARS", () => {
    expect(FORK_HANDOFF_MAX_CHARS).toBe(40_000);
    expect(forkHandoffResponseSchema.safeParse({ handoff: "x".repeat(40_000) }).success).toBe(true);
    expect(forkHandoffResponseSchema.safeParse({ handoff: "x".repeat(40_001) }).success).toBe(
      false
    );
  });
});
