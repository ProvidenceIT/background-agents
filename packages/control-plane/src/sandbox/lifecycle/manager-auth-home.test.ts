import { describe, expect, it, vi } from "vitest";
import { AuthHomeUnavailableError, type SandboxAuthHome, type SandboxProvider } from "../provider";
import type { SessionAuthHomeLookup } from "../../auth-homes/sandbox-mount";
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
  noLifetime,
} from "./test-helpers";

const HOME: SandboxAuthHome = {
  pvcName: "sf-home-bram",
  ownerUserId: "u1",
  providers: ["anthropic"],
};

function fixture(options: {
  provider: SandboxProvider;
  lookup: SessionAuthHomeLookup["getForSession"];
  sandbox?: ReturnType<typeof createMockSandbox>;
}) {
  const session = createMockSession({ session_name: "public-session" });
  const storage = createMockStorage(
    session,
    options.sandbox ?? createMockSandbox({ status: "pending" })
  );
  const getForSession = vi.fn(options.lookup);
  const manager = createTestLifecycleManager(
    options.provider,
    storage,
    storage,
    createMockBroadcaster(),
    createMockWebSocketManager(false),
    createMockAlarmScheduler(),
    createMockIdGenerator(),
    createUnmanagedShutdown(),
    { ...createTestConfig(), authHomeLookup: { getForSession } }
  );
  return { manager, storage, getForSession };
}

describe("subscription home at launch", () => {
  it("hands a fresh create the home bound to the session", async () => {
    const provider = createMockProvider({ capabilities: { supportsAuthHomeMounts: true } });
    const f = fixture({ provider, lookup: async () => HOME });

    await f.manager.spawnSandbox();

    expect(f.getForSession).toHaveBeenCalledExactlyOnceWith("public-session");
    expect(vi.mocked(provider.createSandbox).mock.calls[0]![0].authHome).toEqual(HOME);
  });

  it("creates without a home when none is bound", async () => {
    const provider = createMockProvider({ capabilities: { supportsAuthHomeMounts: true } });
    const f = fixture({ provider, lookup: async () => undefined });

    await f.manager.spawnSandbox();

    expect(f.getForSession).toHaveBeenCalledOnce();
    expect(vi.mocked(provider.createSandbox).mock.calls[0]![0]).not.toHaveProperty("authHome");
  });

  it("never asks about homes for a provider that cannot mount one", async () => {
    const provider = createMockProvider();
    const f = fixture({ provider, lookup: async () => HOME });

    await f.manager.spawnSandbox();

    expect(f.getForSession).not.toHaveBeenCalled();
    expect(vi.mocked(provider.createSandbox).mock.calls[0]![0]).not.toHaveProperty("authHome");
  });

  it.each([
    ["a bound home that is gone", new AuthHomeUnavailableError("Subscription home h1 is disabled")],
    ["a failed lookup", new Error("D1 unavailable")],
  ])("starts nothing for %s", async (_case, error) => {
    const provider = createMockProvider({ capabilities: { supportsAuthHomeMounts: true } });
    const f = fixture({
      provider,
      lookup: async () => {
        throw error;
      },
    });

    await f.manager.spawnSandbox();

    expect(provider.createSandbox).not.toHaveBeenCalled();
    expect(f.storage.getSandbox()?.last_spawn_error).toContain(
      error instanceof AuthHomeUnavailableError ? "disabled" : "D1 unavailable"
    );
  });

  it.each([
    ["the home bound now", HOME],
    ["no home when the binding is gone", undefined],
  ])("resumes with %s, read afresh", async (_case, bound) => {
    const resumeSandbox = vi.fn(async () => ({ success: true as const, lifetime: noLifetime() }));
    const provider = createMockProvider({
      resumeSandbox,
      stopSandbox: vi.fn(async () => ({ success: true })),
      capabilities: {
        supportsAuthHomeMounts: true,
        supportsPersistentResume: true,
        supportsExplicitStop: true,
      },
    });
    const f = fixture({
      provider,
      lookup: async () => bound,
      sandbox: createMockSandbox({ status: "stopped", modal_object_id: "retained-source" }),
    });

    await f.manager.spawnSandbox();

    expect(resumeSandbox).toHaveBeenCalledOnce();
    expect(provider.createSandbox).not.toHaveBeenCalled();
    expect(f.getForSession).toHaveBeenCalledExactlyOnceWith("public-session");
    const config = (resumeSandbox.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    if (bound) expect(config.authHome).toEqual(HOME);
    else expect(config).not.toHaveProperty("authHome");
  });
});
