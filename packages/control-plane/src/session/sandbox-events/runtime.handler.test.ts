import { sandboxEventSchema, type SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { describe, expect, it, vi } from "vitest";
import { SandboxRuntimeEventHandler } from "./runtime.handler";
import type { SandboxEventContext } from "./context";

type ReadyEvent = Extract<SandboxEvent, { type: "ready" }>;

function readyEvent(extra: Record<string, unknown> = {}): ReadyEvent {
  return sandboxEventSchema.parse({
    type: "ready",
    sandboxId: "sb-1",
    timestamp: 1,
    harness: "claude",
    ...extra,
  }) as ReadyEvent;
}

function harness() {
  const tasks: Array<() => Promise<void>> = [];
  const recordClaudeExpiry = vi.fn(async (_expiresAt: number) => undefined);
  const handler = new SandboxRuntimeEventHandler(
    { getSession: () => ({ harness: "claude" }) } as never,
    { recordReportedSandboxRuntimeVersion: () => undefined } as never,
    { createEvent: () => undefined } as never,
    { broadcast: () => undefined } as never,
    { pinBaselines: () => undefined } as never,
    (() => ({ ok: true })) as never,
    () => undefined,
    () => undefined,
    async () => undefined,
    { submit: (task: () => Promise<void>) => void tasks.push(task) },
    { processMessageQueue: async () => undefined },
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    { onRuntimeReady: () => false } as never,
    recordClaudeExpiry
  );
  const drain = async () => {
    for (const task of tasks.splice(0)) await task();
  };
  return { handler, recordClaudeExpiry, drain };
}

const context = { now: 1, messageId: null, processingMessage: null };

describe("SandboxRuntimeEventHandler.handleReady with a mounted auth home", () => {
  it("records the Claude token expiry the bridge reported, as epoch milliseconds", async () => {
    const { handler, recordClaudeExpiry, drain } = harness();
    await handler.handleReady(
      readyEvent({
        auth_home: {
          present: true,
          providers: ["anthropic"],
          claude_expires_at: "2027-10-09T10:30:00Z",
        },
      }),
      context
    );
    await drain();
    expect(recordClaudeExpiry).toHaveBeenCalledExactlyOnceWith(Date.UTC(2027, 9, 9, 10, 30));
  });

  it("records nothing when no home is mounted or its expiry file is missing", async () => {
    const { handler, recordClaudeExpiry, drain } = harness();
    await handler.handleReady(readyEvent(), context);
    await handler.handleReady(
      readyEvent({ auth_home: { present: true, providers: [], claude_expires_at: null } }),
      context
    );
    await drain();
    expect(recordClaudeExpiry).not.toHaveBeenCalled();
  });
});

function heartbeatHandler(onHeartbeat?: () => void) {
  const sandboxRepository = { updateSandboxHeartbeat: vi.fn() };
  const updateLastActivity = vi.fn();
  const runtime = new SandboxRuntimeEventHandler(
    {} as never,
    sandboxRepository as never,
    {} as never,
    {} as never,
    {} as never,
    vi.fn() as never,
    updateLastActivity,
    vi.fn(),
    vi.fn(),
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    onHeartbeat
  );
  return { runtime, sandboxRepository };
}

const heartbeatContext = { now: 1234, processingMessage: null } as unknown as SandboxEventContext;

describe("SandboxRuntimeEventHandler.handleHeartbeat", () => {
  it("records the heartbeat and tells the liveness observer", () => {
    const onHeartbeat = vi.fn();
    const { runtime, sandboxRepository } = heartbeatHandler(onHeartbeat);

    runtime.handleHeartbeat(heartbeatContext);

    expect(sandboxRepository.updateSandboxHeartbeat).toHaveBeenCalledWith(1234);
    expect(onHeartbeat).toHaveBeenCalledOnce();
  });

  it("works without an observer", () => {
    const { runtime, sandboxRepository } = heartbeatHandler();
    runtime.handleHeartbeat(heartbeatContext);
    expect(sandboxRepository.updateSandboxHeartbeat).toHaveBeenCalledWith(1234);
  });
});
