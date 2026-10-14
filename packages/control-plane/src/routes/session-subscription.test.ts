import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { sessionSubscriptionResponseSchema } from "@open-inspect/shared/types/session-subscription";
import { HOUSEHOLD, seedHousehold } from "../auth-homes/auth-homes.test-support";
import type { SqlDatabase } from "../db/sql-database";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase } from "../node/sqlite-database";
import type { Env } from "../types";
import type { SessionRouteContext } from "./session-route";
import { handleSessionSubscription } from "./session-subscription";

let db: SqlDatabase & { close(): void };

beforeEach(async () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(
    sqlite,
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
  );
  db = createNodeSqlDatabase(sqlite);
  await seedHousehold(db);
  await db
    .prepare("DELETE FROM session_model_provider_auth WHERE session_id = ?")
    .bind(HOUSEHOLD.sessionId)
    .run();
  await db
    .prepare(
      `INSERT INTO model_provider_accounts
         (id, provider, display_name, status, created_by, owner_user_id, created_at, updated_at)
       VALUES ('0123456789abcdef0123456789abcdef', 'openai', 'Owner ChatGPT Pro', 'active', ?, ?, 1, 1)`
    )
    .bind(HOUSEHOLD.owner, HOUSEHOLD.owner)
    .run();
  const authRows: Array<[string, string, string | null, string]> = [
    ["anthropic", "auth_home", null, "auth_home_shared"],
    ["openai", "provider_account", "0123456789abcdef0123456789abcdef", "explicit"],
    ["xai", "api_key", null, "api_key_fallback"],
  ];
  for (const [provider, mode, accountId, source] of authRows) {
    await db
      .prepare(
        `INSERT INTO session_model_provider_auth
           (session_id, provider, auth_mode, provider_account_id, selection_source, created_at)
         VALUES (?, ?, ?, ?, ?, 1)`
      )
      .bind(HOUSEHOLD.sessionId, provider, mode, accountId, source)
      .run();
  }
});
afterEach(() => db.close());

async function subscriptionsFor(userId: string, permissions: PermissionId[] = []) {
  const ctx = { db, authorization: { userId, permissions } } as unknown as SessionRouteContext;
  const response = await handleSessionSubscription(
    new Request("https://test.local"),
    {} as Env,
    { id: HOUSEHOLD.sessionId },
    ctx
  );
  expect(response.status).toBe(200);
  const body = sessionSubscriptionResponseSchema.parse(await response.json());
  return Object.fromEntries(body.subscriptions.map((entry) => [entry.provider, entry]));
}

describe("handleSessionSubscription", () => {
  it("names the holder's own home and account to the holder", async () => {
    const subscriptions = await subscriptionsFor(HOUSEHOLD.owner);
    expect(subscriptions.anthropic).toEqual({
      provider: "anthropic",
      authMode: "auth_home",
      holder: "you",
      shared: true,
      holderUserId: HOUSEHOLD.owner,
      holderDisplayName: HOUSEHOLD.owner,
      accountDisplayName: null,
    });
    expect(subscriptions.openai).toMatchObject({
      holder: "you",
      holderUserId: HOUSEHOLD.owner,
      accountDisplayName: "Owner ChatGPT Pro",
    });
    expect(subscriptions.xai).toMatchObject({ holder: "workspace", holderUserId: null });
    expect(subscriptions["zai-coding-plan"]).toEqual({
      provider: "zai-coding-plan",
      authMode: "auth_home",
      holder: "you",
      shared: false,
      holderUserId: HOUSEHOLD.owner,
      holderDisplayName: HOUSEHOLD.owner,
      accountDisplayName: null,
    });
  });

  it("reports workspace credentials for Z.AI when no home serves the session", async () => {
    await db
      .prepare("UPDATE sessions SET auth_home_id = NULL, auth_home_selection = NULL WHERE id = ?")
      .bind(HOUSEHOLD.sessionId)
      .run();
    const subscriptions = await subscriptionsFor(HOUSEHOLD.owner);
    expect(subscriptions["zai-coding-plan"]).toMatchObject({
      authMode: "api_key",
      holder: "workspace",
      holderUserId: null,
    });
  });

  it("tells another viewer a colleague's subscription is used without naming them", async () => {
    const subscriptions = await subscriptionsFor(HOUSEHOLD.colleague);
    expect(subscriptions.anthropic).toMatchObject({
      holder: "colleague",
      shared: true,
      holderUserId: null,
      holderDisplayName: null,
    });
    expect(subscriptions.openai).toMatchObject({
      holder: "colleague",
      holderUserId: null,
      accountDisplayName: null,
    });
    expect(subscriptions["zai-coding-plan"]).toMatchObject({
      holder: "colleague",
      holderUserId: null,
    });
  });

  it("names the holder to workspace administrators", async () => {
    const subscriptions = await subscriptionsFor(HOUSEHOLD.colleague, ["auth_homes.read_all"]);
    expect(subscriptions.anthropic).toMatchObject({
      holder: "colleague",
      holderUserId: HOUSEHOLD.owner,
      holderDisplayName: HOUSEHOLD.owner,
    });
    expect(subscriptions.openai).toMatchObject({ accountDisplayName: "Owner ChatGPT Pro" });
  });

  it("names the lending colleague to the person who started the session", async () => {
    await db
      .prepare("UPDATE sessions SET trigger_actor_user_id = ? WHERE id = ?")
      .bind(HOUSEHOLD.colleague, HOUSEHOLD.sessionId)
      .run();
    const subscriptions = await subscriptionsFor(HOUSEHOLD.colleague);
    expect(subscriptions.anthropic).toMatchObject({
      holder: "colleague",
      shared: true,
      holderUserId: HOUSEHOLD.owner,
    });
  });

  it("returns 404 for an unknown session", async () => {
    const ctx = {
      db,
      authorization: { userId: HOUSEHOLD.owner, permissions: [] },
    } as unknown as SessionRouteContext;
    const response = await handleSessionSubscription(
      new Request("https://test.local"),
      {} as Env,
      { id: "missing" },
      ctx
    );
    expect(response.status).toBe(404);
  });
});
