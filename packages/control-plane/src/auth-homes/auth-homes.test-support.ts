/**
 * Test-only household fixture for the auth-home turn gate: seeds a migrated
 * database (the caller opens it; worker code may not import the Node
 * adapters) with an owner whose home H1 carries Anthropic and is
 * shared, a colleague whose home H2 carries the Z.AI Coding Plan, an
 * unenrolled user, and one owner session bound to H1.
 */

import type { SubscriptionSharingPolicy } from "@open-inspect/shared/types/auth-homes";
import type { SqlDatabase } from "../db/sql-database";
import { SubscriptionSharingStore, UserAuthHomeStore } from "./store";

export const HOUSEHOLD = {
  owner: "user-owner",
  colleague: "user-colleague",
  unenrolled: "user-unenrolled",
  sessionId: "session-h1",
  homeId: "H1",
} as const;

export interface HouseholdFixture {
  db: SqlDatabase;
  setPolicy(policy: SubscriptionSharingPolicy): Promise<void>;
  /** Rows of one audit action, metadata parsed. */
  auditRows(action: string): Promise<Array<{ actor: string | null; metadata: unknown }>>;
}

export async function seedHousehold(db: SqlDatabase): Promise<HouseholdFixture> {
  for (const userId of [HOUSEHOLD.owner, HOUSEHOLD.colleague, HOUSEHOLD.unenrolled]) {
    await db
      .prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, 1, 1)")
      .bind(userId, userId)
      .run();
  }
  const homes = new UserAuthHomeStore(db);
  await homes.register({
    id: HOUSEHOLD.homeId,
    ownerUserIds: [HOUSEHOLD.owner],
    pvcName: "sf-home-owner",
    nodeName: "agent.dokman.io",
    providers: ["anthropic", "zai-coding-plan"],
    shared: true,
    sharingConsentAt: 1,
    now: 1,
  });
  await homes.register({
    id: "H2",
    ownerUserIds: [HOUSEHOLD.colleague],
    pvcName: "sf-home-colleague",
    nodeName: "agent.dokman.io",
    providers: ["zai-coding-plan"],
    now: 2,
  });
  await db
    .prepare(
      `INSERT INTO sessions (id, title, repo_owner, repo_name, model, status, user_id, visibility,
         created_at, updated_at, trigger_actor_user_id, trigger_kind, auth_home_id,
         auth_home_selection)
       VALUES (?, 'Owner session', NULL, NULL, 'anthropic/claude-sonnet-4-6', 'completed', ?,
         'workspace', 1, 1, ?, 'prompt', ?, 'own')`
    )
    .bind(HOUSEHOLD.sessionId, HOUSEHOLD.owner, HOUSEHOLD.owner, HOUSEHOLD.homeId)
    .run();

  return {
    db,
    async setPolicy(policy) {
      await new SubscriptionSharingStore(db).set(policy, HOUSEHOLD.owner);
    },
    async auditRows(action) {
      const rows = await db
        .prepare(
          `SELECT actor_user_id_snapshot, metadata_json FROM authorization_audit_events
           WHERE action = ? ORDER BY occurred_at, id`
        )
        .bind(action)
        .all<{ actor_user_id_snapshot: string | null; metadata_json: string }>();
      return rows.results.map((row) => ({
        actor: row.actor_user_id_snapshot,
        metadata: JSON.parse(row.metadata_json),
      }));
    },
  };
}
