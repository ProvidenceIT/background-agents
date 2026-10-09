import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { SubscriptionSharingStore, UserAuthHomeStore } from "../auth-homes/store";
import { createSubscriptionSecretSharing } from "./subscription-secret-owners";

describe("createSubscriptionSecretSharing", () => {
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

  it("reads the policy and the homes, and audits a shared use by name only", async () => {
    await new UserAuthHomeStore(db).register({
      id: "H1",
      ownerUserIds: ["u1"],
      pvcName: "sf-home-u1",
      nodeName: "sandbox-node-1",
      providers: ["zai-coding-plan"],
      shared: true,
      sharingConsentAt: 1,
    });
    await new SubscriptionSharingStore(db).set("owner_only", "u1");
    const sharing = createSubscriptionSecretSharing(db);

    const state = await sharing.load();
    expect(state.policy).toBe("owner_only");
    expect(state.homes.map((home) => home.id)).toEqual(["H1"]);

    await sharing.recordShared({
      sessionId: "s1",
      actorUserId: "u2",
      uses: [{ key: "ZHIPU_API_KEY", homeId: "H1", homeOwnerUserId: "u1" }],
    });
    const rows = await db
      .prepare(
        `SELECT actor_user_id_snapshot, resource_id, target_user_id_snapshot, metadata_json
         FROM authorization_audit_events WHERE action = 'credential.subscription_secret_shared'`
      )
      .all<{ metadata_json: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      actor_user_id_snapshot: "u2",
      resource_id: "s1",
      target_user_id_snapshot: "u1",
    });
    expect(JSON.parse(rows.results[0]!.metadata_json)).toMatchObject({
      secret: "ZHIPU_API_KEY",
      home_id: "H1",
      home_owner: "u1",
      actor: "u2",
    });
  });
});
