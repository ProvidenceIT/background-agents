import { CODEX_SEAT } from "@open-inspect/shared/types/auth-homes";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { CODEX_PROVIDER_REQUIRED, createCodexSeatGate, type CodexSeatGate } from "./codex-seat";
import {
  AUTH_HOME_LEASE_HEARTBEAT_INTERVAL_MS,
  AUTH_HOME_SEAT_POLL_MS,
  AuthHomeLeaseStore,
  type AuthHomeClaimFence,
  type AuthHomeClaimPod,
} from "./lease";
import { UserAuthHomeStore } from "./store";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe("createCodexSeatGate", () => {
  let sqlite: DatabaseSync;
  let db: NodeSqlDatabase;
  let now: number;
  let pods: AuthHomeClaimPod[];
  let listed: string[];
  let fence: AuthHomeClaimFence;

  beforeEach(async () => {
    sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    db = createNodeSqlDatabase(sqlite);
    now = 5_000_000;
    pods = [];
    listed = [];
    fence = {
      listPodsMountingClaim: async (claim) => {
        listed.push(claim);
        return pods;
      },
      deletePod: async () => {},
    };
    await new UserAuthHomeStore(db).register({
      id: "H1",
      ownerUserIds: ["user-bram"],
      pvcName: "sf-home-bram",
      nodeName: "sandbox-node-1",
      providers: ["anthropic", "openai"],
    });
    for (const [id, harness] of [
      ["S1", "codex"],
      ["S2", "codex"],
      ["S3", "claude"],
    ]) {
      await db
        .prepare(
          "INSERT INTO sessions (id, harness, auth_home_id, created_at, updated_at) VALUES (?, ?, 'H1', 1, 1)"
        )
        .bind(id, harness)
        .run();
    }
  });
  afterEach(() => sqlite.close());

  interface Probe {
    retries: number[];
    drives: number;
  }

  function gate(
    sessionId: string,
    harness: string,
    options: { withFence?: boolean } = {}
  ): CodexSeatGate & { probe: Probe } {
    const probe: Probe = { retries: [], drives: 0 };
    const seat = createCodexSeatGate({
      db,
      getSessionId: () => sessionId,
      getHarness: () => harness,
      provider: options.withFence === false ? {} : { authHomeClaimFence: () => fence },
      scheduleRetry: async (at) => {
        probe.retries.push(at);
      },
      driveQueue: async () => {
        probe.drives++;
      },
      log: log as never,
      now: () => now,
    });
    return { ...seat, probe };
  }

  it("lets a session on another harness through without touching the seat", async () => {
    expect(await gate("S3", "claude").admit()).toEqual({ admitted: true });
    expect(listed).toEqual([]);
  });

  it("refuses Codex on a provider that cannot mount homes", async () => {
    expect(await gate("S1", "codex", { withFence: false }).admit()).toEqual({
      admitted: false,
      reason: CODEX_PROVIDER_REQUIRED,
    });
  });

  it("seats the first Codex session on the home's Codex claim", async () => {
    expect(await gate("S1", "codex").admit()).toEqual({ admitted: true });
    expect(listed).toEqual(["sf-home-bram-codex"]);
    expect(await new AuthHomeLeaseStore(db).get("H1", CODEX_SEAT)).toMatchObject({
      sessionId: "S1",
    });
  });

  it("makes the second wait for the seat, asks it to poll, and seats it after a release", async () => {
    const first = gate("S1", "codex");
    const second = gate("S2", "codex");
    await first.admit();

    expect(await second.admit()).toEqual({
      admitted: false,
      reason:
        "Waiting for your Codex seat: another Codex session is running on this subscription home (position 1 in the queue). This session starts when it ends.",
    });
    expect(second.probe.retries).toEqual([now + AUTH_HOME_SEAT_POLL_MS]);

    await second.poll();
    expect(second.probe.drives).toBe(1);

    await first.release();
    expect(await second.admit()).toEqual({ admitted: true });
    await second.poll();
    expect(second.probe.drives).toBe(1);
  });

  it("renews the seat at most once per heartbeat interval", async () => {
    const seat = gate("S1", "codex");
    await seat.admit();
    const leases = new AuthHomeLeaseStore(db);
    const grantedAt = now;

    now += AUTH_HOME_LEASE_HEARTBEAT_INTERVAL_MS - 1;
    await seat.heartbeat("pod-a");
    expect((await leases.get("H1", CODEX_SEAT))?.heartbeatAt).toBe(grantedAt);

    now += 1;
    await seat.heartbeat("pod-a");
    expect(await leases.get("H1", CODEX_SEAT)).toMatchObject({
      heartbeatAt: now,
      podName: "pod-a",
    });
  });

  it("does nothing on release or poll for a session on another harness", async () => {
    await gate("S1", "codex").admit();
    const other = gate("S3", "claude");
    await other.release();
    await other.poll();
    expect(other.probe.drives).toBe(0);
    expect(await new AuthHomeLeaseStore(db).get("H1", CODEX_SEAT)).toMatchObject({
      sessionId: "S1",
    });
  });
});
