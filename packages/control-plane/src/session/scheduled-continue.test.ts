import { describe, expect, it, vi } from "vitest";
import type { TurnLimit } from "@open-inspect/shared/types/sandbox-events";
import type {
  ScheduledContinueFailure,
  ServerMessage,
} from "@open-inspect/shared/types/server-messages";
import type { Logger } from "../logger";
import type { EnqueuePromptRequest } from "./enqueue-prompt-contract";
import type { ScheduledContinue } from "./session-core-repository";
import { AuthHomeTurnRefusedError } from "../auth-homes/turn-admission";
import { UsageQuotaExceededError } from "../authorization/usage-quotas";
import { BudgetExhaustedError, SandboxPromptBlockedError } from "./message-queue";
import {
  CONTINUE_AT_RESET_MAX_RETRIES,
  CONTINUE_AT_RESET_RETRY_MS,
  SessionScheduledContinue,
} from "./scheduled-continue";

const NOW = 1_790_000_000_000;
const RESET = NOW + 3_600_000;
const LIMIT: TurnLimit = {
  kind: "subscription_limit",
  window: "five_hour",
  resetsAtMs: RESET,
  subscriptionSlot: "claude-1",
  harness: "claude",
};

const log: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => log,
} as unknown as Logger;

function setup(
  overrides: {
    limit?: TurnLimit | null;
    status?: string;
    budgetExhausted?: boolean;
    queued?: number;
    authorization?: "allowed" | "denied" | "unavailable";
    enqueue?: (request: EnqueuePromptRequest) => Promise<unknown>;
  } = {}
) {
  const state = {
    now: NOW,
    stored: null as ScheduledContinue | null,
    failure: null as ScheduledContinueFailure | null,
    limit: overrides.limit === undefined ? LIMIT : overrides.limit,
    status: overrides.status ?? "active",
    budgetExhausted: overrides.budgetExhausted ?? false,
    queued: overrides.queued ?? 0,
  };
  const broadcasts: ServerMessage[] = [];
  const armed: number[] = [];
  const enqueued: EnqueuePromptRequest[] = [];
  const authorizeUser = vi.fn(async () => overrides.authorization ?? "allowed");
  const scheduled = new SessionScheduledContinue({
    repository: {
      getScheduledContinue: () => state.stored,
      setScheduledContinue: (schedule) => {
        state.stored = schedule;
      },
      getScheduledContinueFailure: () => state.failure,
      setScheduledContinueFailure: (failure) => {
        state.failure = failure;
      },
      getLastTurnLimit: () => state.limit,
      getSession: () =>
        ({ status: state.status, budget_exhausted: state.budgetExhausted ? 1 : 0 }) as never,
    },
    messageRepository: { getPendingOrProcessingCount: () => state.queued },
    alarmScheduler: {
      schedule: async (at) => {
        armed.push(at);
      },
    },
    messenger: { broadcast: (message) => broadcasts.push(message) },
    authorizeUser,
    enqueuePrompt:
      overrides.enqueue ??
      (async (request) => {
        enqueued.push(request);
      }),
    now: () => state.now,
    log,
  });
  return { scheduled, state, broadcasts, armed, enqueued, authorizeUser };
}

const requester = { requestedByUserId: "user-1", authorId: "user-1" };

describe("SessionScheduledContinue", () => {
  it("schedules a minute after the reset, arms the alarm and tells clients", async () => {
    const { scheduled, state, broadcasts, armed } = setup();

    await expect(scheduled.schedule(requester)).resolves.toEqual({
      kind: "scheduled",
      atMs: RESET + 60_000,
    });

    expect(state.stored).toEqual({
      atMs: RESET + 60_000,
      requestedByUserId: "user-1",
      authorId: "user-1",
      createdAtMs: NOW,
    });
    expect(scheduled.atMs()).toBe(RESET + 60_000);
    expect(armed).toEqual([RESET + 60_000]);
    expect(broadcasts).toEqual([
      {
        type: "scheduled_continue",
        scheduledContinueAtMs: RESET + 60_000,
        scheduledContinueFailure: null,
      },
    ]);
  });

  it("keeps one schedule when asked twice", async () => {
    const { scheduled, state } = setup();
    await scheduled.schedule(requester);
    state.now = NOW + 10;
    await scheduled.schedule({ requestedByUserId: "user-2", authorId: "user-2" });

    expect(state.stored).toEqual({
      atMs: RESET + 60_000,
      requestedByUserId: "user-2",
      authorId: "user-2",
      createdAtMs: NOW + 10,
    });
  });

  it.each([
    ["no limit", null],
    ["a limit with no reset time", { ...LIMIT, resetsAtMs: null }],
    ["a reset already past", { ...LIMIT, resetsAtMs: NOW }],
  ])("refuses %s", async (_label, limit) => {
    const { scheduled, state, armed, broadcasts } = setup({ limit: limit as TurnLimit | null });

    await expect(scheduled.schedule(requester)).resolves.toEqual({ kind: "no_future_reset" });
    expect(state.stored).toBeNull();
    expect(armed).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it("refuses while the session cost limit is reached", async () => {
    const { scheduled, state, armed, broadcasts } = setup({ budgetExhausted: true });

    await expect(scheduled.schedule(requester)).resolves.toEqual({ kind: "budget_exhausted" });
    expect(state.stored).toBeNull();
    expect(armed).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it("cancels and tells clients even when nothing was scheduled", async () => {
    const { scheduled, state, broadcasts } = setup();
    await scheduled.schedule(requester);
    scheduled.cancel();
    scheduled.cancel();

    expect(state.stored).toBeNull();
    expect(broadcasts.slice(1)).toEqual([
      { type: "scheduled_continue", scheduledContinueAtMs: null, scheduledContinueFailure: null },
      { type: "scheduled_continue", scheduledContinueAtMs: null, scheduledContinueFailure: null },
    ]);
  });

  it("clears only an existing schedule", async () => {
    const { scheduled, state, broadcasts } = setup();
    scheduled.clear("prompt_enqueued");
    expect(broadcasts).toEqual([]);

    await scheduled.schedule(requester);
    scheduled.clear("prompt_enqueued");
    expect(state.stored).toBeNull();
    expect(broadcasts.at(-1)).toEqual({
      type: "scheduled_continue",
      scheduledContinueAtMs: null,
      scheduledContinueFailure: null,
    });
  });

  it("re-arms an early alarm and leaves the schedule in place", async () => {
    const { scheduled, state, armed, enqueued } = setup();
    await scheduled.schedule(requester);
    state.now = RESET;

    await scheduled.fireIfDue();

    expect(armed).toEqual([RESET + 60_000, RESET + 60_000]);
    expect(state.stored?.atMs).toBe(RESET + 60_000);
    expect(enqueued).toEqual([]);
  });

  it("enqueues the continue as the requester when due, after clearing it", async () => {
    const { scheduled, state, enqueued, broadcasts, authorizeUser } = setup();
    await scheduled.schedule(requester);
    state.now = RESET + 60_000;

    await scheduled.fireIfDue();

    expect(authorizeUser).toHaveBeenCalledWith("user-1", "collaborate");
    expect(enqueued).toEqual([
      {
        turn: { triggerKind: "prompt", channel: "prompt", requestId: `continue-at-reset:${NOW}` },
        content: "Continue where you stopped.",
        authorId: "user-1",
        canonicalUserId: "user-1",
        source: "web",
      },
    ]);
    expect(state.stored).toBeNull();
    expect(broadcasts.at(-1)).toEqual({
      type: "scheduled_continue",
      scheduledContinueAtMs: null,
      scheduledContinueFailure: null,
    });
  });

  it.each([
    ["the limit cleared", { limit: null }],
    ["a prompt is queued", { queued: 1 }],
    ["the session is archived", { status: "archived" }],
    ["the session is cancelled", { status: "cancelled" }],
  ])("drops a due continue when %s", async (_label, change) => {
    const { scheduled, state, enqueued, authorizeUser } = setup();
    await scheduled.schedule(requester);
    Object.assign(state, change, { now: RESET + 60_000 });

    await scheduled.fireIfDue();

    expect(enqueued).toEqual([]);
    expect(state.stored).toBeNull();
    expect(authorizeUser).not.toHaveBeenCalled();
  });

  it("drops a due continue when the requester may no longer collaborate", async () => {
    const { scheduled, state, enqueued } = setup({ authorization: "denied" });
    await scheduled.schedule(requester);
    state.now = RESET + 60_000;

    await scheduled.fireIfDue();

    expect(enqueued).toEqual([]);
    expect(state.stored).toBeNull();
  });

  it("does nothing when the schedule was cancelled while authorization was read", async () => {
    const { scheduled, state, enqueued, authorizeUser } = setup();
    await scheduled.schedule(requester);
    state.now = RESET + 60_000;
    authorizeUser.mockImplementationOnce(async () => {
      scheduled.cancel();
      return "allowed";
    });

    await scheduled.fireIfDue();

    expect(enqueued).toEqual([]);
    expect(state.stored).toBeNull();
  });

  it("retries later when authorization cannot be read", async () => {
    const { scheduled, state, armed, enqueued } = setup({ authorization: "unavailable" });
    await scheduled.schedule(requester);
    state.now = RESET + 60_000;

    await scheduled.fireIfDue();

    expect(enqueued).toEqual([]);
    expect(state.stored?.atMs).toBe(RESET + 60_000 + CONTINUE_AT_RESET_RETRY_MS);
    expect(armed.at(-1)).toBe(RESET + 60_000 + CONTINUE_AT_RESET_RETRY_MS);
  });

  it.each([
    ["the session budget", () => new BudgetExhaustedError()],
    [
      "the home",
      () =>
        new AuthHomeTurnRefusedError({
          reason: "kind_disabled",
          provider: "anthropic",
          message: "Prompts are disabled on this home.",
        }),
    ],
    [
      "the usage quota",
      () =>
        new UsageQuotaExceededError({
          quota: {
            id: "quota-1",
            scopeKind: "team",
            scopeId: "team-1",
            period: "month",
            maxTurns: null,
            maxCostUsd: 50,
            maxTokens: null,
            maxRunningSandboxes: null,
            action: "block",
            createdBy: "owner",
            createdAt: 1,
            updatedAt: 1,
          },
          window: { period: "month", startAt: 0, endAt: 1 },
          usage: { turns: 10, tokens: 0, costUsd: 50 },
          exceeded: ["cost"],
        }),
    ],
  ])("drops a continue whose enqueue %s refuses", async (_label, refusal) => {
    const { scheduled, state, armed } = setup({
      enqueue: async () => {
        throw refusal();
      },
    });
    await scheduled.schedule(requester);
    state.now = RESET + 60_000;

    await expect(scheduled.fireIfDue()).resolves.toBeUndefined();
    expect(state.stored).toBeNull();
    expect(armed).toEqual([RESET + 60_000]);
  });

  it.each([
    ["a sandbox recovery hold", () => new SandboxPromptBlockedError("Sandbox needs recovery")],
    ["a database error", () => new Error("D1_ERROR: network connection lost")],
  ])("retries a continue whose enqueue fails on %s", async (_label, failure) => {
    let calls = 0;
    const enqueued: EnqueuePromptRequest[] = [];
    const { scheduled, state, armed, broadcasts } = setup({
      enqueue: async (request) => {
        calls += 1;
        if (calls === 1) throw failure();
        enqueued.push(request);
      },
    });
    await scheduled.schedule(requester);
    state.now = RESET + 60_000;

    await scheduled.fireIfDue();

    const retryAtMs = RESET + 60_000 + CONTINUE_AT_RESET_RETRY_MS;
    expect(state.stored).toEqual({
      atMs: retryAtMs,
      requestedByUserId: "user-1",
      authorId: "user-1",
      createdAtMs: NOW,
      retries: 1,
    });
    expect(armed.at(-1)).toBe(retryAtMs);
    expect(broadcasts.at(-1)).toEqual({
      type: "scheduled_continue",
      scheduledContinueAtMs: retryAtMs,
      scheduledContinueFailure: null,
    });

    state.now = retryAtMs;
    await scheduled.fireIfDue();

    expect(enqueued.map((request) => request.content)).toEqual(["Continue where you stopped."]);
    expect(state.stored).toBeNull();
  });

  it("drops a continue whose enqueue keeps failing once its retries are spent", async () => {
    let calls = 0;
    const { scheduled, state, armed } = setup({
      enqueue: async () => {
        calls += 1;
        throw new Error("D1_ERROR: network connection lost");
      },
    });
    await scheduled.schedule(requester);
    state.now = RESET + 60_000;

    for (let attempt = 0; attempt <= CONTINUE_AT_RESET_MAX_RETRIES; attempt += 1) {
      await scheduled.fireIfDue();
      state.now += CONTINUE_AT_RESET_RETRY_MS;
    }

    expect(calls).toBe(CONTINUE_AT_RESET_MAX_RETRIES + 1);
    expect(state.stored).toBeNull();
    expect(armed).toHaveLength(CONTINUE_AT_RESET_MAX_RETRIES + 1);
  });

  it("does not restore a failed continue once a prompt landed during the enqueue", async () => {
    const { scheduled, state } = setup({
      enqueue: async () => {
        state.queued = 1;
        throw new Error("D1_ERROR: network connection lost");
      },
    });
    await scheduled.schedule(requester);
    state.now = RESET + 60_000;

    await scheduled.fireIfDue();

    expect(state.stored).toBeNull();
  });

  it("stops retrying unreadable authorization once its retries are spent", async () => {
    const { scheduled, state, enqueued } = setup({ authorization: "unavailable" });
    await scheduled.schedule(requester);
    state.now = RESET + 60_000;

    for (let attempt = 0; attempt <= CONTINUE_AT_RESET_MAX_RETRIES; attempt += 1) {
      await scheduled.fireIfDue();
      state.now += CONTINUE_AT_RESET_RETRY_MS;
    }

    expect(enqueued).toEqual([]);
    expect(state.stored).toBeNull();
  });

  it("keeps the refusal for the session view when a due continue is refused", async () => {
    const { scheduled, state, broadcasts } = setup({
      enqueue: async () => {
        throw new BudgetExhaustedError();
      },
    });
    await scheduled.schedule(requester);
    state.now = RESET + 60_000;

    await scheduled.fireIfDue();

    const failure = { reason: "refused", refusal: "budget_exhausted", atMs: RESET + 60_000 };
    expect(state.failure).toEqual(failure);
    expect(broadcasts.at(-1)).toEqual({
      type: "scheduled_continue",
      scheduledContinueAtMs: null,
      scheduledContinueFailure: failure,
    });
  });

  it("keeps only the code of a refusal that describes the requester's own quota", async () => {
    const quotaRefusal = new UsageQuotaExceededError({
      quota: {
        id: "quota-1",
        scopeKind: "user",
        scopeId: "member-1",
        period: "day",
        maxTurns: 800,
        maxCostUsd: null,
        maxTokens: null,
        maxRunningSandboxes: null,
        action: "block",
        createdBy: "owner",
        createdAt: 1,
        updatedAt: 1,
      },
      window: { period: "day", startAt: 0, endAt: 1 },
      usage: { turns: 812, tokens: 0, costUsd: 0 },
      exceeded: ["turns"],
    });
    expect(quotaRefusal.message).toContain("812 of 800");
    const { scheduled, state, broadcasts } = setup({
      enqueue: async () => {
        throw quotaRefusal;
      },
    });
    await scheduled.schedule(requester);
    state.now = RESET + 60_000;

    await scheduled.fireIfDue();

    const failure = { reason: "refused", refusal: "usage_quota_exceeded", atMs: RESET + 60_000 };
    expect(state.failure).toEqual(failure);
    expect(broadcasts.at(-1)).toEqual({
      type: "scheduled_continue",
      scheduledContinueAtMs: null,
      scheduledContinueFailure: failure,
    });
    expect(JSON.stringify(broadcasts)).not.toContain("812");
  });

  it("keeps why a due continue was dropped for a requester who lost access", async () => {
    const { scheduled, state, broadcasts } = setup({ authorization: "denied" });
    await scheduled.schedule(requester);
    state.now = RESET + 60_000;

    await scheduled.fireIfDue();

    const failure = { reason: "requester_cannot_collaborate", refusal: null, atMs: RESET + 60_000 };
    expect(state.failure).toEqual(failure);
    expect(broadcasts.at(-1)).toEqual({
      type: "scheduled_continue",
      scheduledContinueAtMs: null,
      scheduledContinueFailure: failure,
    });
  });

  it("keeps why a due continue was dropped once its retries are spent", async () => {
    const { scheduled, state } = setup({
      enqueue: async () => {
        throw new Error("D1_ERROR: network connection lost");
      },
    });
    await scheduled.schedule(requester);
    state.now = RESET + 60_000;

    for (let attempt = 0; attempt <= CONTINUE_AT_RESET_MAX_RETRIES; attempt += 1) {
      await scheduled.fireIfDue();
      if (attempt < CONTINUE_AT_RESET_MAX_RETRIES) state.now += CONTINUE_AT_RESET_RETRY_MS;
    }

    expect(state.failure).toEqual({
      reason: "retries_exhausted",
      refusal: null,
      atMs: RESET + 60_000 + CONTINUE_AT_RESET_MAX_RETRIES * CONTINUE_AT_RESET_RETRY_MS,
    });
  });

  it("keeps no failure when the session moved on before the continue was due", async () => {
    const { scheduled, state } = setup();
    await scheduled.schedule(requester);
    Object.assign(state, { queued: 1, now: RESET + 60_000 });

    await scheduled.fireIfDue();

    expect(state.stored).toBeNull();
    expect(state.failure).toBeNull();
  });

  it.each([
    [
      "a prompt is enqueued",
      (scheduled: SessionScheduledContinue) => scheduled.clear("prompt_enqueued"),
    ],
    [
      "the user schedules again",
      (scheduled: SessionScheduledContinue) => scheduled.schedule(requester),
    ],
    ["the user cancels", (scheduled: SessionScheduledContinue) => scheduled.cancel()],
  ])("forgets the failure when %s", async (_label, act) => {
    const { scheduled, state, broadcasts } = setup({ authorization: "denied" });
    await scheduled.schedule(requester);
    state.now = RESET + 60_000;
    await scheduled.fireIfDue();
    state.now = NOW + 1;

    await act(scheduled);

    expect(state.failure).toBeNull();
    expect(broadcasts.at(-1)).toMatchObject({ scheduledContinueFailure: null });
  });

  it("re-arms a persisted schedule after a restart", async () => {
    const { scheduled, state, armed } = setup();
    state.stored = {
      atMs: RESET + 60_000,
      requestedByUserId: "user-1",
      authorId: "user-1",
      createdAtMs: NOW,
    };

    await scheduled.rearm();

    expect(armed).toEqual([RESET + 60_000]);
  });
});
