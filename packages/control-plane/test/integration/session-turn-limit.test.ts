import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, queryDO, seedMessage, serviceFetch } from "./helpers";

const LIMIT = {
  kind: "subscription_limit",
  window: "five_hour",
  resetsAtMs: 1_790_000_000_000,
  subscriptionSlot: "claude-5",
  harness: "claude",
} as const;

async function ownerParticipantId(stub: DurableObjectStub): Promise<string> {
  const [owner] = await queryDO<{ id: string }>(
    stub,
    "SELECT id FROM participants WHERE role = 'owner'"
  );
  if (!owner) throw new Error("Expected an owner participant");
  return owner.id;
}

async function completeTurn(
  stub: DurableObjectStub,
  messageId: string,
  outcome: Record<string, unknown>
): Promise<void> {
  const response = await stub.fetch("http://internal/internal/sandbox-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "execution_complete",
      messageId,
      sandboxId: "sb-limit",
      timestamp: Date.now() / 1000,
      ...outcome,
    }),
  });
  expect(response.status).toBe(200);
}

async function readSession(name: string): Promise<SessionSnapshot["session"]> {
  const response = await serviceFetch(`https://test.local/sessions/${name}`);
  expect(response.status).toBe(200);
  return (await response.json<SessionSnapshot>()).session;
}

describe("lastTurnLimit on the session snapshot", () => {
  beforeEach(cleanD1Tables);

  it("is set by a failed limit turn and cleared by the next successful turn", async () => {
    const name = `turn-limit-${crypto.randomUUID()}`;
    const { stub } = await initNamedSession(name);
    const authorId = await ownerParticipantId(stub);

    expect(await readSession(name)).toMatchObject({
      lastTurnLimit: null,
      forkedFromSessionId: null,
    });

    await seedMessage(stub, {
      id: "msg-limited",
      authorId,
      content: "Refactor the parser",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });
    await completeTurn(stub, "msg-limited", {
      success: false,
      error: "Claude usage limit reached",
      subscriptionSlot: "claude-5",
      limit: LIMIT,
    });

    expect((await readSession(name)).lastTurnLimit).toEqual(LIMIT);

    await seedMessage(stub, {
      id: "msg-continued",
      authorId,
      content: "Continue where you stopped.",
      source: "web",
      status: "processing",
      createdAt: Date.now(),
      startedAt: Date.now(),
    });
    await completeTurn(stub, "msg-continued", { success: true });

    expect((await readSession(name)).lastTurnLimit).toBeNull();
  });

  it("is not set by a failed turn without a limit", async () => {
    const name = `turn-limit-none-${crypto.randomUUID()}`;
    const { stub } = await initNamedSession(name);
    await seedMessage(stub, {
      id: "msg-crashed",
      authorId: await ownerParticipantId(stub),
      content: "Run the tests",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    await completeTurn(stub, "msg-crashed", { success: false, error: "Sandbox crashed" });

    expect((await readSession(name)).lastTurnLimit).toBeNull();
  });

  it("ignores a limit on a completion for a turn that is no longer processing", async () => {
    const name = `turn-limit-stale-${crypto.randomUUID()}`;
    const { stub } = await initNamedSession(name);

    await completeTurn(stub, "msg-unknown", { success: false, limit: LIMIT });

    expect((await readSession(name)).lastTurnLimit).toBeNull();
  });
});
