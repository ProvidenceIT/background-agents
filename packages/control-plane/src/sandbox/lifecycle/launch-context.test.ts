import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FINAL_SNAPSHOT_BUFFER_MS } from "@open-inspect/shared/types/integrations";
import { SandboxProviderError } from "../provider";
import { SandboxLaunchContext } from "./launch-context";
import {
  createMockAlarmScheduler,
  createMockBroadcaster,
  createMockIdGenerator,
  createMockProvider,
  createMockSandbox,
  createMockSession,
  createMockStorage,
  createMockWebSocketManager,
  createTestConfig,
  createTestLifecycleManager,
  createUnmanagedShutdown,
} from "./test-helpers";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

function createContext(
  options: {
    executionTimeoutMs?: string;
    supportsSandboxTimeout?: boolean;
    providerName?: string;
  } = {}
) {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const context = new SandboxLaunchContext({
    sessionContext: {
      getSessionRepositories: () => [],
      getUserEnvVars: async () => undefined,
    },
    provider: {
      name: options.providerName ?? "modal",
      capabilities: {
        supportsSandboxTimeout: options.supportsSandboxTimeout ?? true,
        supportsAuthHomeMounts: false,
      },
    },
    config: {
      model: "anthropic/claude-sonnet-4-5",
      executionTimeoutMs: options.executionTimeoutMs,
    },
    getLogger: () => logger,
  });
  return { context, logger };
}

function sessionWithSettings(settings: Record<string, unknown> | null) {
  return createMockSession({
    sandbox_settings: settings === null ? null : JSON.stringify(settings),
  });
}

describe("SandboxLaunchContext.resolveSandboxSettings", () => {
  it("falls back to EXECUTION_TIMEOUT_MS when no scope sets a sandbox timeout", () => {
    const { context, logger } = createContext({ executionTimeoutMs: String(FOUR_HOURS_MS) });

    const resolved = context.resolveSandboxSettings(sessionWithSettings(null));

    expect(resolved.timeoutSeconds).toBe(FOUR_HOURS_MS / 1000);
    expect(resolved.sandboxSettings).toEqual({});
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("leaves the lifetime to the provider when EXECUTION_TIMEOUT_MS is unset", () => {
    const { context } = createContext();

    expect(
      context.resolveSandboxSettings(sessionWithSettings(null)).timeoutSeconds
    ).toBeUndefined();
  });

  it("lets an explicit sandboxTimeoutMs win over EXECUTION_TIMEOUT_MS", () => {
    const { context } = createContext({ executionTimeoutMs: String(FOUR_HOURS_MS) });

    const resolved = context.resolveSandboxSettings(
      sessionWithSettings({ sandboxTimeoutMs: 3_600_000 })
    );

    expect(resolved.timeoutSeconds).toBe(3600);
    expect(resolved.sandboxSettings.sandboxTimeoutMs).toBe(3_600_000);
  });

  it("rounds EXECUTION_TIMEOUT_MS up to whole seconds so the TTL never undercuts the budget", () => {
    const { context } = createContext({ executionTimeoutMs: "6300500" });

    expect(context.resolveSandboxSettings(sessionWithSettings(null)).timeoutSeconds).toBe(6301);
  });

  it("ignores EXECUTION_TIMEOUT_MS on a provider without configurable timeouts", () => {
    const { context, logger } = createContext({
      executionTimeoutMs: String(FOUR_HOURS_MS),
      supportsSandboxTimeout: false,
    });

    const resolved = context.resolveSandboxSettings(sessionWithSettings(null));

    expect(resolved.timeoutSeconds).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("still refuses an explicit timeout on a provider without configurable timeouts", () => {
    const { context } = createContext({ supportsSandboxTimeout: false });

    expect(() =>
      context.resolveSandboxSettings(sessionWithSettings({ sandboxTimeoutMs: 3_600_000 }))
    ).toThrow(SandboxProviderError);
  });

  it.each(["", "   ", "abc", "1000ms", "0", "-5000", "1.5"])(
    "ignores a malformed EXECUTION_TIMEOUT_MS of %j",
    (raw) => {
      const { context, logger } = createContext({ executionTimeoutMs: raw });

      expect(
        context.resolveSandboxSettings(sessionWithSettings(null)).timeoutSeconds
      ).toBeUndefined();
      expect(logger.warn).not.toHaveBeenCalled();
    }
  );

  it("ignores EXECUTION_TIMEOUT_MS that does not exceed the default final snapshot buffer", () => {
    const { context, logger } = createContext({
      executionTimeoutMs: String(DEFAULT_FINAL_SNAPSHOT_BUFFER_MS),
    });

    expect(
      context.resolveSandboxSettings(sessionWithSettings(null)).timeoutSeconds
    ).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Ignoring EXECUTION_TIMEOUT_MS"),
      expect.objectContaining({
        event: "sandbox.execution_timeout_ignored",
        provider: "modal",
        execution_timeout_ms: DEFAULT_FINAL_SNAPSHOT_BUFFER_MS,
        final_snapshot_buffer_ms: DEFAULT_FINAL_SNAPSHOT_BUFFER_MS,
      })
    );
  });

  it("measures the buffer guard against the scope's own final snapshot buffer", () => {
    const { context, logger } = createContext({ executionTimeoutMs: "600000" });

    const shortened = context.resolveSandboxSettings(
      sessionWithSettings({ finalSnapshotBufferMs: 300_000 })
    );
    expect(shortened.timeoutSeconds).toBe(600);
    expect(logger.warn).not.toHaveBeenCalled();

    const lengthened = context.resolveSandboxSettings(
      sessionWithSettings({ finalSnapshotBufferMs: 900_000 })
    );
    expect(lengthened.timeoutSeconds).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({
        event: "sandbox.execution_timeout_ignored",
        final_snapshot_buffer_ms: 900_000,
      })
    );
  });
});

describe("sandbox lifetime at launch", () => {
  it("hands a fresh create the EXECUTION_TIMEOUT_MS lifetime when no scope sets one", async () => {
    const provider = createMockProvider();
    const storage = createMockStorage(
      createMockSession({ sandbox_settings: null }),
      createMockSandbox({ status: "pending" })
    );
    const manager = createTestLifecycleManager(
      provider,
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      { ...createTestConfig(), executionTimeoutMs: String(FOUR_HOURS_MS) }
    );

    await manager.spawnSandbox();

    expect(vi.mocked(provider.createSandbox).mock.calls[0]![0].timeoutSeconds).toBe(
      FOUR_HOURS_MS / 1000
    );
  });
});
