import { describe, expect, it, vi } from "vitest";
import type { TurnLimit } from "@open-inspect/shared/types/sandbox-events";
import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import type { Logger } from "../logger";
import type { EnqueuePromptRequest } from "./enqueue-prompt-contract";
import type { ScheduledContinue } from "./session-core-repository";
import { CONTINUE_AT_RESET_RETRY_MS, SessionScheduledContinue } from "./scheduled-continue";

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
    queued?: number;
    authorization?: "allowed" | "denied" | "unavailable";
    enqueue?: (request: EnqueuePromptRequest) => Promise<unknown>;
  } = {}
) {
  const state = {
    now: NOW,
    stored: null as ScheduledContinue | null,
    limit: overrides.limit === undefined ? LIMIT : overrides.limit,
    status: overrides.status ?? "active",
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
      getLastTurnLimit: () => state.limit,
      getSession: () => ({ status: state.status }) as never,
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
      { type: "scheduled_continue", scheduledContinueAtMs: RESET + 60_000 },
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

  it("cancels and tells clients even when nothing was scheduled", async () => {
    const { scheduled, state, broadcasts } = setup();
    await scheduled.schedule(requester);
    scheduled.cancel();
    scheduled.cancel();

    expect(state.stored).toBeNull();
    expect(broadcasts.slice(1)).toEqual([
      { type: "scheduled_continue", scheduledContinueAtMs: null },
      { type: "scheduled_continue", scheduledContinueAtMs: null },
    ]);
  });

  it("clears only an existing schedule", async () => {
    const { scheduled, state, broadcasts } = setup();
    scheduled.clear("prompt_enqueued");
    expect(broadcasts).toEqual([]);

    await scheduled.schedule(requester);
    scheduled.clear("prompt_enqueued");
    expect(state.stored).toBeNull();
    expect(broadcasts.at(-1)).toEqual({ type: "scheduled_continue", scheduledContinueAtMs: null });
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
    expect(broadcasts.at(-1)).toEqual({ type: "scheduled_continue", scheduledContinueAtMs: null });
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

  it("drops a continue whose enqueue is refused", async () => {
    const { scheduled, state } = setup({
      enqueue: async () => {
        throw new Error("Usage quota reached");
      },
    });
    await scheduled.schedule(requester);
    state.now = RESET + 60_000;

    await expect(scheduled.fireIfDue()).resolves.toBeUndefined();
    expect(state.stored).toBeNull();
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
