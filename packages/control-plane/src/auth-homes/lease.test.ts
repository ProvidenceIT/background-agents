import { CODEX_SEAT } from "@open-inspect/shared/types/auth-homes";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import {
  AUTH_HOME_LEASE_EXPIRY_MS,
  AUTH_HOME_LEASE_QUEUE_STALE_MS,
  AuthHomeLeaseStore,
  codexClaimName,
  type AuthHomeClaimFence,
  type AuthHomeClaimPod,
} from "./lease";
import { UserAuthHomeStore } from "./store";

const MIGRATIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../terraform/d1/migrations"
);
const H1 = "H1";
const CLAIM = codexClaimName("sf-home-bram");

/** The provider side of fencing: pods mounting the claim, and the deletes asked for. */
class FakeFence implements AuthHomeClaimFence {
  pods: AuthHomeClaimPod[] = [];
  deleted: string[] = [];
  listed: string[] = [];

  async listPodsMountingClaim(claimName: string): Promise<AuthHomeClaimPod[]> {
    this.listed.push(claimName);
    return this.pods.map((pod) => ({ ...pod }));
  }

  async deletePod(pod: AuthHomeClaimPod): Promise<void> {
    this.deleted.push(pod.name);
    // Deletion is a request: the pod lingers, terminating, until the kubelet is done.
    this.pods = this.pods.map((entry) =>
      entry.name === pod.name ? { ...entry, terminating: true } : entry
    );
  }

  mount(name: string, sessionId: string | null): void {
    this.pods.push({ name, uid: `uid-${name}`, sessionId, terminating: false });
  }

  gone(name: string): void {
    this.pods = this.pods.filter((pod) => pod.name !== name);
  }
}

describe("AuthHomeLeaseStore (the fenced Codex seat)", () => {
  let sqlite: DatabaseSync;
  let db: NodeSqlDatabase;
  let now: number;
  let leases: AuthHomeLeaseStore;
  let fence: FakeFence;

  const request = (sessionId: string) => ({
    homeId: H1,
    provider: CODEX_SEAT,
    sessionId,
    claimName: CLAIM,
  });

  beforeEach(async () => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    applyMigrations(sqlite, MIGRATIONS);
    db = createNodeSqlDatabase(sqlite);
    now = 1_000_000;
    await new UserAuthHomeStore(db).register({
      id: H1,
      ownerUserIds: ["user-bram"],
      pvcName: "sf-home-bram",
      nodeName: "agent.dokman.io",
      providers: ["openai"],
      now,
    });
    leases = new AuthHomeLeaseStore(db, () => now);
    fence = new FakeFence();
  });
  afterEach(() => sqlite.close());

  it("names the Codex claim after the home's claim", () => {
    expect(CLAIM).toBe("sf-home-bram-codex");
  });

  it("grants the first of two concurrent acquires and queues the second", async () => {
    const [first, second] = await Promise.all([
      leases.acquire(request("S1"), fence),
      leases.acquire(request("S2"), fence),
    ]);

    expect(first).toMatchObject({ kind: "granted", seat: { sessionId: "S1", homeId: H1 } });
    expect(second).toMatchObject({ kind: "waiting", reason: "held" });
    expect(await leases.isWaiting("S2")).toBe(true);
    expect(fence.listed).toEqual([CLAIM, CLAIM]);
    // Its next poll sees the settled order.
    expect(await leases.acquire(request("S2"), fence)).toEqual({
      kind: "waiting",
      reason: "held",
      position: 1,
      holderSessionId: "S1",
    });
  });

  it("serializes many concurrent acquires onto one holder", async () => {
    const decisions = await Promise.all(
      ["S1", "S2", "S3", "S4"].map((id) => leases.acquire(request(id), fence))
    );
    expect(decisions.filter((decision) => decision.kind === "granted")).toHaveLength(1);
  });

  it("hands the seat to the next waiter once the holder releases it", async () => {
    await leases.acquire(request("S1"), fence);
    now += 1_000;
    await leases.acquire(request("S2"), fence);

    now += 1_000;
    expect(await leases.release("S1")).toEqual(["S2"]);
    const decision = await leases.acquire(request("S2"), fence);

    expect(decision).toMatchObject({ kind: "granted", seat: { sessionId: "S2" } });
    expect(await leases.isWaiting("S2")).toBe(false);
  });

  it("serves waiters first in, first out", async () => {
    await leases.acquire(request("S1"), fence);
    now += 1;
    await leases.acquire(request("S2"), fence);
    now += 1;
    await leases.acquire(request("S3"), fence);
    await leases.release("S1");

    // S3 asks first, but S2 is ahead of it.
    expect(await leases.acquire(request("S3"), fence)).toEqual({
      kind: "waiting",
      reason: "held",
      position: 2,
      holderSessionId: null,
    });
    expect(await leases.acquire(request("S2"), fence)).toMatchObject({ kind: "granted" });
  });

  it("drops a waiter that stopped asking", async () => {
    await leases.acquire(request("S1"), fence);
    await leases.acquire(request("S2"), fence);
    now += 1;
    await leases.acquire(request("S3"), fence);
    await leases.release("S1");

    now += AUTH_HOME_LEASE_QUEUE_STALE_MS - 1;
    await leases.acquire(request("S3"), fence);
    now += 2;
    expect(await leases.acquire(request("S3"), fence)).toMatchObject({ kind: "granted" });
  });

  it("renews the holder on heartbeat and refuses one from anyone else", async () => {
    await leases.acquire(request("S1"), fence);
    now += 60_000;

    expect(await leases.heartbeat({ homeId: H1, provider: CODEX_SEAT, sessionId: "S2" })).toBe(
      false
    );
    expect(await leases.heartbeatSession("S1", "sandbox-s1")).toBe(true);
    expect(await leases.get(H1, CODEX_SEAT)).toMatchObject({
      sessionId: "S1",
      heartbeatAt: now,
      podName: "sandbox-s1",
    });
  });

  it("keeps the seat with a live holder however long the waiter asks", async () => {
    await leases.acquire(request("S1"), fence);
    fence.mount("pod-s1", "S1");
    now += AUTH_HOME_LEASE_EXPIRY_MS - 1;

    expect(await leases.acquire(request("S2"), fence)).toMatchObject({
      kind: "waiting",
      reason: "held",
    });
    expect(fence.deleted).toEqual([]);
  });

  it("fences a silent holder: deletes its pod and grants only once the pod is gone", async () => {
    await leases.acquire(request("S1"), fence);
    fence.mount("pod-s1", "S1");
    now += AUTH_HOME_LEASE_EXPIRY_MS + 1;

    const fencing = await leases.acquire(request("S2"), fence);
    expect(fencing).toEqual({
      kind: "waiting",
      reason: "fencing",
      position: 1,
      holderSessionId: "S1",
    });
    expect(fence.deleted).toEqual(["pod-s1"]);
    expect(await leases.get(H1, CODEX_SEAT)).toMatchObject({ sessionId: "S1", fencedAt: now });

    // The pod is still terminating: every poll waits and no second delete is sent.
    for (let poll = 0; poll < 3; poll++) {
      now += 30_000;
      expect(await leases.acquire(request("S2"), fence)).toMatchObject({
        kind: "waiting",
        reason: "fencing",
      });
    }
    expect(fence.deleted).toEqual(["pod-s1"]);

    fence.gone("pod-s1");
    now += 30_000;
    expect(await leases.acquire(request("S2"), fence)).toMatchObject({
      kind: "granted",
      seat: { sessionId: "S2", acquiredAt: now },
    });
  });

  it("lets a fenced holder that comes back keep nothing it lost", async () => {
    await leases.acquire(request("S1"), fence);
    fence.mount("pod-s1", "S1");
    now += AUTH_HOME_LEASE_EXPIRY_MS + 1;
    await leases.acquire(request("S2"), fence);
    fence.gone("pod-s1");
    await leases.acquire(request("S2"), fence);

    expect(await leases.heartbeatSession("S1")).toBe(false);
  });

  it("refuses the seat while any pod of another session mounts the claim, even with no lease row", async () => {
    // The control-plane restart case: the row is gone, a Codex pod still runs.
    fence.mount("pod-orphan", "S9");

    expect(await leases.acquire(request("S2"), fence)).toEqual({
      kind: "waiting",
      reason: "claim_mounted",
      position: 1,
      holderSessionId: null,
    });
    expect(fence.deleted).toEqual([]);
    expect(await leases.get(H1, CODEX_SEAT)).toBeNull();

    fence.gone("pod-orphan");
    expect(await leases.acquire(request("S2"), fence)).toMatchObject({ kind: "granted" });
  });

  it("does not count the acquiring session's own previous pod against it", async () => {
    fence.mount("pod-s1-old", "S1");
    expect(await leases.acquire(request("S1"), fence)).toMatchObject({ kind: "granted" });
  });

  it("lists each home's holder and live queue", async () => {
    await leases.acquire(request("S1"), fence);
    now += 5;
    await leases.acquire(request("S2"), fence);

    expect(await leases.status([H1], CODEX_SEAT)).toEqual([
      {
        homeId: H1,
        provider: CODEX_SEAT,
        holder: expect.objectContaining({ sessionId: "S1" }),
        waiting: [{ sessionId: "S2", position: 1, enqueuedAt: now }],
      },
    ]);
  });

  it("drops a home's seat and queue with the home", async () => {
    await leases.acquire(request("S1"), fence);
    await leases.acquire(request("S2"), fence);
    await new UserAuthHomeStore(db).remove(H1);

    expect(await leases.get(H1, CODEX_SEAT)).toBeNull();
    expect(await leases.isWaiting("S2")).toBe(false);
  });
});
