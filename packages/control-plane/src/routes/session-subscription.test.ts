import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { sessionSubscriptionResponseSchema } from "@open-inspect/shared/types/session-subscription";
import { HOUSEHOLD, seedHousehold } from "../auth-homes/auth-homes.test-support";
import type { SqlDatabase } from "../db/sql-database";
import { UsageLedgerStore } from "../db/usage-ledger";
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
  // The household session runs its Claude model on Claude Agent.
  await db
    .prepare("UPDATE sessions SET harness = 'claude' WHERE id = ?")
    .bind(HOUSEHOLD.sessionId)
    .run();
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
      payer: "subscription",
      accountDisplayName: null,
      slots: [],
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
      payer: "subscription",
      accountDisplayName: null,
      slots: [],
    });
  });

  it("reports that nothing pays when the session's harness cannot use the bound Claude home", async () => {
    // BUG-01: OpenCode + a Claude model on a Claude home must not read as "Your Claude subscription".
    await db
      .prepare("UPDATE sessions SET harness = 'opencode' WHERE id = ?")
      .bind(HOUSEHOLD.sessionId)
      .run();
    const subscriptions = await subscriptionsFor(HOUSEHOLD.owner);
    expect(subscriptions.anthropic).toMatchObject({ authMode: "auth_home", payer: "none" });
    expect(subscriptions.openai).toMatchObject({ payer: "provider_account" });
    expect(subscriptions.xai).toMatchObject({ payer: "api_key" });
  });

  it("lists the Claude home slots the session's turns spent, to every viewer", async () => {
    const ledger = new UsageLedgerStore(db);
    const turn = (messageId: string, slot: string | null, settledAt: number) =>
      ledger.recordTurn({
        messageId,
        sessionId: HOUSEHOLD.sessionId,
        userId: HOUSEHOLD.owner,
        repoExternalId: null,
        harness: "claude",
        model: "anthropic/claude-sonnet-4-5",
        costUsd: 0,
        inputTokens: 10,
        outputTokens: 5,
        subscriptionSlot: slot,
        settledAt,
      });
    await turn("msg-1", "claude-2", 100);
    await turn("msg-2", "claude-7", 200);
    await turn("msg-3", "claude-2", 300);
    await turn("msg-4", null, 400);

    const subscriptions = await subscriptionsFor(HOUSEHOLD.colleague);
    expect(subscriptions.anthropic.slots).toEqual([
      { slot: "claude-2", turns: 2, inputTokens: 20, outputTokens: 10, lastUsedAt: 300 },
      { slot: "claude-7", turns: 1, inputTokens: 10, outputTokens: 5, lastUsedAt: 200 },
    ]);
    expect(subscriptions.openai.slots).toEqual([]);
    expect(subscriptions["zai-coding-plan"].slots).toEqual([]);
  });

  it("lists Codex pool slots under openai and keeps them out of the Claude list", async () => {
    // A Codex session on the home: the resolver records openai as auth_home.
    await db
      .prepare(
        `UPDATE session_model_provider_auth
           SET auth_mode = 'auth_home', provider_account_id = NULL, selection_source = 'auth_home_shared'
         WHERE session_id = ? AND provider = 'openai'`
      )
      .bind(HOUSEHOLD.sessionId)
      .run();
    const ledger = new UsageLedgerStore(db);
    const turn = (messageId: string, harness: string | null, slot: string, settledAt: number) =>
      ledger.recordTurn({
        messageId,
        sessionId: HOUSEHOLD.sessionId,
        userId: HOUSEHOLD.owner,
        repoExternalId: null,
        harness,
        model: harness === "codex" ? "openai/gpt-6-sol" : "anthropic/claude-sonnet-4-5",
        costUsd: 0,
        inputTokens: 10,
        outputTokens: 5,
        subscriptionSlot: slot,
        settledAt,
      });
    await turn("msg-1", "codex", "codex-3", 100);
    await turn("msg-2", "codex", "codex-2", 200);
    await turn("msg-3", "claude", "claude-4", 300);
    await turn("msg-4", null, "claude-1", 400);

    const subscriptions = await subscriptionsFor(HOUSEHOLD.colleague);
    expect(subscriptions.openai.authMode).toBe("auth_home");
    expect(subscriptions.openai.slots.map((entry) => entry.slot)).toEqual(["codex-2", "codex-3"]);
    expect(subscriptions.anthropic.slots.map((entry) => entry.slot)).toEqual([
      "claude-1",
      "claude-4",
    ]);
  });

  it("keeps SuperGrok and Antigravity turns out of the Claude pool", async () => {
    const ledger = new UsageLedgerStore(db);
    const turn = (messageId: string, harness: string, slot: string, settledAt: number) =>
      ledger.recordTurn({
        messageId,
        sessionId: HOUSEHOLD.sessionId,
        userId: HOUSEHOLD.owner,
        repoExternalId: null,
        harness,
        model: "anthropic/claude-sonnet-4-5",
        costUsd: 0,
        inputTokens: 10,
        outputTokens: 5,
        subscriptionSlot: slot,
        settledAt,
      });
    await turn("msg-1", "claude", "claude-4", 100);
    await turn("msg-2", "grok", "grok-acct-1", 200);
    await turn("msg-3", "agy", "agy-acct-2", 300);

    const subscriptions = await subscriptionsFor(HOUSEHOLD.colleague);
    expect(subscriptions.anthropic.slots.map((entry) => entry.slot)).toEqual(["claude-4"]);
    expect(subscriptions.openai.slots).toEqual([]);
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
      slots: [],
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
