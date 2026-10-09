import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { AuthHomeValidationError, SubscriptionSharingStore, UserAuthHomeStore } from "./store";

const FIXED_NOW = Date.UTC(2026, 9, 9, 12);

describe("UserAuthHomeStore", () => {
  let db: NodeSqlDatabase;
  let store: UserAuthHomeStore;

  beforeEach(() => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    db = createNodeSqlDatabase(sqlite);
    store = new UserAuthHomeStore(db);
  });
  afterEach(() => db.close());

  it("registers a home for every owner id and lists it for each of them", async () => {
    const home = await store.register({
      id: "H1",
      ownerUserIds: ["U1a", "U1b"],
      pvcName: "sf-home-u1",
      nodeName: "agent.dokman.io",
      providers: ["anthropic", "openai"],
      backgroundConsentAt: FIXED_NOW,
      now: FIXED_NOW,
    });
    expect(home).toEqual({
      id: "H1",
      ownerUserIds: ["U1a", "U1b"],
      pvcName: "sf-home-u1",
      nodeName: "agent.dokman.io",
      providers: ["anthropic", "openai"],
      kindsEnabled: ["prompt", "child", "mention", "issue_label", "pr_event", "schedule"],
      backgroundConsentAt: FIXED_NOW,
      maxConcurrent: 3,
      shared: false,
      sharingConsentAt: null,
      status: "active",
      registeredAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });

    const second = await store.register({
      id: "H2",
      ownerUserIds: ["U2"],
      pvcName: "sf-home-u2",
      nodeName: "agent.dokman.io",
      providers: ["anthropic"],
      shared: false,
      now: FIXED_NOW + 1,
    });
    expect(second.shared).toBe(false);

    await expect(store.listForUser("U1b")).resolves.toEqual([home]);
    await expect(store.listForUser("U1a")).resolves.toEqual([home]);
    await expect(store.findOwnedBy("U2")).resolves.toEqual(second);
    // "U1" is a substring of both owner ids and matches neither.
    await expect(store.listForUser("U1")).resolves.toEqual([]);
    await expect(store.listForUser("U3")).resolves.toEqual([]);
    await expect(store.list()).resolves.toEqual([home, second]);
    await expect(store.getById("H2")).resolves.toEqual(second);
    await expect(store.listShared()).resolves.toEqual([]);
  });

  it("updates consent and sharing, lists shared homes, and removes a home", async () => {
    await store.register({
      id: "H1",
      ownerUserIds: ["U1"],
      pvcName: "sf-home-u1",
      nodeName: "agent.dokman.io",
      providers: ["anthropic"],
      now: FIXED_NOW,
    });
    const updated = await store.update("H1", {
      shared: true,
      sharingConsentAt: FIXED_NOW + 5,
      kindsEnabled: ["prompt", "mention"],
      maxConcurrent: 1,
      now: FIXED_NOW + 5,
    });
    expect(updated).toMatchObject({
      id: "H1",
      ownerUserIds: ["U1"],
      shared: true,
      sharingConsentAt: FIXED_NOW + 5,
      kindsEnabled: ["prompt", "mention"],
      maxConcurrent: 1,
      registeredAt: FIXED_NOW,
      updatedAt: FIXED_NOW + 5,
    });
    await expect(store.listShared()).resolves.toEqual([updated]);
    await expect(store.getById("H1")).resolves.toEqual(updated);

    const disabled = await store.update("H1", { status: "disabled", now: FIXED_NOW + 6 });
    expect(disabled?.status).toBe("disabled");
    await expect(store.listShared()).resolves.toEqual([]);

    await expect(store.update("missing", { shared: false })).resolves.toBeNull();
    await expect(store.remove("H1")).resolves.toBe(true);
    await expect(store.remove("H1")).resolves.toBe(false);
    await expect(store.getById("H1")).resolves.toBeNull();
  });

  it("refuses sharing without consent, a claim outside the sf-home- prefix, and a second claim with the same name", async () => {
    await expect(
      store.register({
        ownerUserIds: ["U1"],
        pvcName: "sf-home-u1",
        nodeName: "agent.dokman.io",
        providers: ["anthropic"],
        shared: true,
      })
    ).rejects.toThrow(AuthHomeValidationError);
    await expect(
      store.register({
        ownerUserIds: ["U1"],
        pvcName: "workspace-u1",
        nodeName: "agent.dokman.io",
        providers: ["anthropic"],
      })
    ).rejects.toThrow(/pvcName/);
    const home = await store.register({
      ownerUserIds: ["U1"],
      pvcName: "sf-home-u1",
      nodeName: "agent.dokman.io",
      providers: ["anthropic"],
    });
    expect(home.id).toMatch(/^ah_[0-9a-f]{32}$/);
    await expect(
      store.register({
        ownerUserIds: ["U2"],
        pvcName: "sf-home-u1",
        nodeName: "agent.dokman.io",
        providers: ["anthropic"],
      })
    ).rejects.toThrow(/UNIQUE/);
    await expect(store.update(home.id, { shared: true })).rejects.toThrow(AuthHomeValidationError);
  });
});

describe("SubscriptionSharingStore", () => {
  let db: NodeSqlDatabase;

  beforeEach(() => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    db = createNodeSqlDatabase(sqlite);
  });
  afterEach(() => db.close());

  it("reads household from an empty table and the written policy afterwards", async () => {
    const store = new SubscriptionSharingStore(db);
    await expect(store.get()).resolves.toBe("household");
    await expect(store.getSnapshot()).resolves.toEqual({
      policy: "household",
      updatedBy: null,
      updatedAt: null,
    });

    await expect(store.set("owner_only", "owner-1", FIXED_NOW)).resolves.toEqual({
      previous: "household",
      current: { policy: "owner_only", updatedBy: "owner-1", updatedAt: FIXED_NOW },
    });
    await expect(store.get()).resolves.toBe("owner_only");

    await expect(store.set("household", "owner-2", FIXED_NOW + 1)).resolves.toEqual({
      previous: "owner_only",
      current: { policy: "household", updatedBy: "owner-2", updatedAt: FIXED_NOW + 1 },
    });
    expect(
      (await db.prepare("SELECT COUNT(*) AS count FROM subscription_sharing").first())?.count
    ).toBe(1);
  });
});
