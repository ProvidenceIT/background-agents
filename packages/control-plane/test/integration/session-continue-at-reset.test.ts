import { env, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import { cleanD1Tables } from "./cleanup";
import {
  initNamedSession,
  queryDO,
  seedMessage,
  serviceFetch,
  waitForSandboxStatus,
} from "./helpers";
import { runInSessionDO } from "./session-do-access";

const BASE = "https://test.local";
const MEMBER = "33333333333333333333333333333333";

async function seedLimitedSession(resetsAtMs: number | null) {
  const name = `continue-at-reset-${crypto.randomUUID()}`;
  const { stub } = await initNamedSession(name, {
    title: "Fix the parser",
    repoOwner: "acme",
    repoName: "web-app",
    repoId: 12345,
    defaultBranch: "main",
    model: "anthropic/claude-opus-4-6",
    userId: MEMBER,
    canonicalUserId: MEMBER,
  });
  await waitForSandboxStatus(stub, "failed");
  await queryDO(
    stub,
    "UPDATE session SET harness = 'claude', last_turn_limit = ?",
    JSON.stringify({
      kind: "subscription_limit",
      window: "five_hour",
      resetsAtMs,
      subscriptionSlot: "claude-1",
      harness: "claude",
    })
  );
  return { name, stub };
}

function continueAtReset(name: string, method: "POST" | "DELETE", body?: string) {
  return serviceFetch(`${BASE}/sessions/${name}/continue-at-reset`, {
    method,
    ...(body !== undefined ? { body } : {}),
    as: { userId: MEMBER, role: "member" },
  });
}

async function snapshotScheduledAt(name: string): Promise<number | null | undefined> {
  const response = await serviceFetch(`${BASE}/sessions/${name}`, {
    as: { userId: MEMBER, role: "member" },
  });
  return (await response.json<SessionSnapshot>()).session.scheduledContinueAtMs;
}

async function storedSchedule(stub: DurableObjectStub) {
  const [row] = await queryDO<{ scheduled_continue: string | null }>(
    stub,
    "SELECT scheduled_continue FROM session"
  );
  return row.scheduled_continue ? JSON.parse(row.scheduled_continue) : null;
}

async function makeDue(stub: DurableObjectStub) {
  const schedule = await storedSchedule(stub);
  await queryDO(
    stub,
    "UPDATE session SET scheduled_continue = ?",
    JSON.stringify({ ...schedule, atMs: Date.now() - 1 })
  );
}

async function messageContents(stub: DurableObjectStub) {
  return (await queryDO<{ content: string }>(stub, "SELECT content FROM messages")).map(
    ({ content }) => content
  );
}

describe("continue when the limit resets", () => {
  beforeEach(cleanD1Tables);

  it("schedules a minute after the reset and shows it on the snapshot", async () => {
    const resetsAtMs = Date.now() + 3_600_000;
    const { name, stub } = await seedLimitedSession(resetsAtMs);

    const response = await continueAtReset(name, "POST");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ scheduledContinueAtMs: resetsAtMs + 60_000 });
    expect(await snapshotScheduledAt(name)).toBe(resetsAtMs + 60_000);
    expect(await storedSchedule(stub)).toEqual({
      atMs: resetsAtMs + 60_000,
      requestedByUserId: MEMBER,
      authorId: MEMBER,
      createdAtMs: expect.any(Number),
    });
    const alarm = await runInSessionDO(stub, (_instance: SessionDO, state) =>
      state.storage.getAlarm()
    );
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThanOrEqual(resetsAtMs + 60_000);
  });

  it("keeps one schedule when asked twice and cancels it", async () => {
    const resetsAtMs = Date.now() + 3_600_000;
    const { name, stub } = await seedLimitedSession(resetsAtMs);

    expect((await continueAtReset(name, "POST")).status).toBe(200);
    expect((await continueAtReset(name, "POST")).status).toBe(200);
    expect((await storedSchedule(stub)).atMs).toBe(resetsAtMs + 60_000);

    const cancelled = await continueAtReset(name, "DELETE");
    expect(cancelled.status).toBe(200);
    await expect(cancelled.json()).resolves.toEqual({ scheduledContinueAtMs: null });
    expect(await snapshotScheduledAt(name)).toBeNull();
    expect(await storedSchedule(stub)).toBeNull();
    expect((await continueAtReset(name, "DELETE")).status).toBe(200);
  });

  it.each([
    ["no reset time", null],
    ["a reset already past", 1_000],
  ])("refuses a limit with %s", async (_label, resetsAtMs) => {
    const { name } = await seedLimitedSession(resetsAtMs);

    const response = await continueAtReset(name, "POST");

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "The last turn has no limit that resets later",
      code: "no_future_reset",
    });
    expect(await snapshotScheduledAt(name)).toBeNull();
  });

  it("rejects a body", async () => {
    const { name } = await seedLimitedSession(Date.now() + 3_600_000);

    const response = await continueAtReset(name, "POST", JSON.stringify({ atMs: 1 }));

    expect(response.status).toBe(400);
  });

  it("enqueues the continue as the requester when the alarm finds it due", async () => {
    const { name, stub } = await seedLimitedSession(Date.now() + 3_600_000);
    expect((await continueAtReset(name, "POST")).status).toBe(200);
    await makeDue(stub);

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    expect(await messageContents(stub)).toEqual(["Continue where you stopped."]);
    const [author] = await queryDO<{ user_id: string }>(
      stub,
      "SELECT p.user_id FROM messages m JOIN participants p ON p.id = m.author_id"
    );
    expect(author).toEqual({ user_id: MEMBER });
    expect(await storedSchedule(stub)).toBeNull();
    expect(await snapshotScheduledAt(name)).toBeNull();
  });

  it("leaves a schedule that is not yet due and re-arms for it", async () => {
    const resetsAtMs = Date.now() + 3_600_000;
    const { name, stub } = await seedLimitedSession(resetsAtMs);
    expect((await continueAtReset(name, "POST")).status).toBe(200);

    await runDurableObjectAlarm(stub);

    expect(await messageContents(stub)).toEqual([]);
    expect((await storedSchedule(stub)).atMs).toBe(resetsAtMs + 60_000);
    const alarm = await runInSessionDO(stub, (_instance: SessionDO, state) =>
      state.storage.getAlarm()
    );
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThanOrEqual(resetsAtMs + 60_000);
  });

  it("drops a due continue once the limit has cleared", async () => {
    const { name, stub } = await seedLimitedSession(Date.now() + 3_600_000);
    expect((await continueAtReset(name, "POST")).status).toBe(200);
    await makeDue(stub);
    await queryDO(stub, "UPDATE session SET last_turn_limit = NULL");

    await runDurableObjectAlarm(stub);

    expect(await messageContents(stub)).toEqual([]);
    expect(await storedSchedule(stub)).toBeNull();
  });

  it("re-arms the schedule after the runtime restarts", async () => {
    const resetsAtMs = Date.now() + 3_600_000;
    const { name, stub } = await seedLimitedSession(resetsAtMs);
    expect((await continueAtReset(name, "POST")).status).toBe(200);
    await queryDO(stub, "DELETE FROM session_alarm_state");
    await runInSessionDO(stub, (_instance: SessionDO, state) => state.storage.deleteAlarm());

    await expect(
      runInSessionDO(stub, (_instance: SessionDO, state) => {
        state.abort("test: restart");
      })
    ).rejects.toThrow();
    const restored = env.SESSION.get(env.SESSION.idFromName(name));
    expect(await snapshotScheduledAt(name)).toBe(resetsAtMs + 60_000);
    let alarm: number | null = null;
    for (let attempt = 0; attempt < 50 && alarm === null; attempt++) {
      alarm = await runInSessionDO(restored, (_instance: SessionDO, state) =>
        state.storage.getAlarm()
      );
      if (alarm === null) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(alarm).toBe(resetsAtMs + 60_000);

    await makeDue(restored);
    await expect(runDurableObjectAlarm(restored)).resolves.toBe(true);
    expect(await messageContents(restored)).toEqual(["Continue where you stopped."]);
  });

  it("clears the schedule when someone prompts", async () => {
    const { name, stub } = await seedLimitedSession(Date.now() + 3_600_000);
    expect((await continueAtReset(name, "POST")).status).toBe(200);

    const prompted = await serviceFetch(`${BASE}/sessions/${name}/prompt`, {
      method: "POST",
      body: JSON.stringify({ content: "Try a different approach" }),
      as: { userId: MEMBER, role: "member" },
    });

    expect(prompted.status).toBe(200);
    expect(await storedSchedule(stub)).toBeNull();
    expect(await snapshotScheduledAt(name)).toBeNull();
    await waitForSandboxStatus(stub, "failed");
  });

  it("clears the schedule when the session is archived", async () => {
    const { name, stub } = await seedLimitedSession(Date.now() + 3_600_000);
    expect((await continueAtReset(name, "POST")).status).toBe(200);

    expect((await stub.fetch("http://internal/internal/archive", { method: "POST" })).status).toBe(
      200
    );

    expect(await storedSchedule(stub)).toBeNull();
  });

  it("clears the schedule when a turn completes", async () => {
    const { name, stub } = await seedLimitedSession(Date.now() + 3_600_000);
    expect((await continueAtReset(name, "POST")).status).toBe(200);
    const [owner] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE role = 'owner'"
    );
    await seedMessage(stub, {
      id: "msg-in-flight",
      authorId: owner.id,
      content: "Refactor the parser",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    const completed = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "execution_complete",
        messageId: "msg-in-flight",
        success: true,
        sandboxId: "sb-limit",
        timestamp: Date.now() / 1000,
      }),
    });

    expect(completed.status).toBe(200);
    expect(await storedSchedule(stub)).toBeNull();
    expect(await snapshotScheduledAt(name)).toBeNull();
  });
});
