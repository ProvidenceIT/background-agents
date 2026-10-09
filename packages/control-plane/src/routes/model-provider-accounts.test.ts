import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import { ModelProviderAccountStore } from "../db/model-provider-accounts";
import { ProviderDefaultStore } from "../db/provider-account-defaults";
import type { SqlDatabase } from "../db/sql-database";
import {
  ProviderAccountSelectionPolicy,
  ProviderAccountSelectionPolicyError,
} from "../model-provider-accounts/selection-policy";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import {
  authorizationDatabase,
  createTestEnv,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import { modelProviderAccountRoutes } from "./model-provider-accounts";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const handleRequest = createTestRequestHandler([modelProviderAccountRoutes]);
const OWNER = "owner-1";
const COLLEAGUE = "colleague-1";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const TRANSACTION_ID = "ab".repeat(32);
const REFUSAL = {
  error: expect.stringContaining("not stored by the control plane"),
  code: "subscription_token_not_storable",
};

describe("model provider account routes under the auth-home design", () => {
  let store: NodeSqlDatabase;

  beforeEach(async () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    store = createNodeSqlDatabase(sqlite);
    for (const userId of [OWNER, COLLEAGUE]) {
      await store
        .prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, 1, 1)")
        .bind(userId, userId)
        .run();
    }
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: request.headers.get("x-test-user") ?? OWNER },
      request,
    }));
  });
  afterEach(() => store.close());

  function call(method: string, path: string, body?: unknown, userId = OWNER) {
    const DB: SqlDatabase = authorizationDatabase({
      userId,
      statement: (sql) => store.prepare(sql),
      batch: (statements) => store.batch(statements),
    });
    return handleRequest(
      new Request(`https://test.local${path}`, {
        method,
        headers: {
          "x-test-user": userId,
          "x-request-id": `req-${method}-${path}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
      createTestEnv({ ...TEST_SERVICE_SECRETS, DB }),
      TEST_BACKGROUND_TASK_CONTEXT
    );
  }

  async function count(table: string): Promise<number> {
    const row = await store.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
      count: number;
    }>();
    return row?.count ?? -1;
  }

  it("refuses to store a Claude setup token with 422 and writes nothing", async () => {
    const response = await call("POST", "/model-provider-accounts", {
      provider: "anthropic",
      displayName: "My Claude",
      setupToken: "sk-ant-oat01-x",
    });
    expect(response.status).toBe(422);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual(REFUSAL);
    expect(await count("model_provider_accounts")).toBe(0);
    expect(await count("model_provider_account_credentials")).toBe(0);
  });

  it("refuses every Anthropic authorization-code route with 422 and opens no transaction", async () => {
    const start = await call("POST", "/model-provider-accounts/anthropic/authorization-codes", {
      operation: "create",
      displayName: "My Claude",
    });
    expect(start.status).toBe(422);
    await expect(start.json()).resolves.toEqual(REFUSAL);

    const base = `/model-provider-accounts/anthropic/authorization-codes/${TRANSACTION_ID}`;
    for (const [method, path, body] of [
      ["GET", base, undefined],
      ["POST", `${base}/complete`, { code: "pasted-code" }],
      ["DELETE", base, undefined],
    ] as const) {
      const response = await call(method, path, body);
      expect(response.status, `${method} ${path}`).toBe(422);
      await expect(response.json()).resolves.toEqual(REFUSAL);
    }
    expect(await count("model_provider_account_authorizations")).toBe(0);

    // Other providers keep their 409 for a flow they do not support.
    const openai = await call("POST", "/model-provider-accounts/openai/authorization-codes", {
      operation: "create",
      displayName: "OpenAI",
    });
    expect(openai.status).toBe(409);
  });

  it("refuses to reconnect an existing Anthropic account with a pasted token", async () => {
    await new ModelProviderAccountStore(store).create({
      id: ACCOUNT_ID,
      provider: "anthropic",
      displayName: "Preserved Claude",
      status: "reconnect_required",
      actorId: OWNER,
    });
    const response = await call("POST", `/model-provider-accounts/${ACCOUNT_ID}/reconnect`, {
      provider: "anthropic",
      setupToken: "sk-ant-oat01-y",
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(REFUSAL);
    expect(await count("model_provider_account_credentials")).toBe(0);
  });

  it("refuses an unattended default on a connected account with 409", async () => {
    await new ModelProviderAccountStore(store).create({
      id: ACCOUNT_ID,
      provider: "openai",
      displayName: "Owner ChatGPT",
      actorId: OWNER,
    });
    const response = await call("PUT", "/model-provider-account-defaults/openai", {
      providerAccountId: ACCOUNT_ID,
      unattendedMode: "provider_account",
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining("Unattended runs cannot spend a connected provider account"),
    });
    expect(await count("model_provider_account_defaults")).toBe(0);

    const attended = await call("PUT", "/model-provider-account-defaults/openai", {
      providerAccountId: ACCOUNT_ID,
      unattendedMode: "api_key",
    });
    expect(attended.status).toBe(200);
    await expect(attended.json()).resolves.toMatchObject({
      default: { provider: "openai", providerAccountId: ACCOUNT_ID, unattendedMode: "api_key" },
    });

    const colleague = await call(
      "PUT",
      "/model-provider-account-defaults/openai",
      { providerAccountId: ACCOUNT_ID, unattendedMode: "api_key" },
      COLLEAGUE
    );
    expect(colleague.status).toBe(403);
  });

  describe("selection policy", () => {
    const adapters = { get: () => ({}) };

    it("lets the owner select their account and refuses every other actor with 403", async () => {
      const accounts = new ModelProviderAccountStore(store);
      await accounts.create({
        id: ACCOUNT_ID,
        provider: "openai",
        displayName: "Owner ChatGPT",
        actorId: OWNER,
      });
      await expect(accounts.getById(ACCOUNT_ID)).resolves.toMatchObject({
        ownerUserId: OWNER,
        createdBy: OWNER,
      });
      const policy = new ProviderAccountSelectionPolicy(accounts, adapters);

      await expect(policy.validateSelection("openai", ACCOUNT_ID, OWNER)).resolves.toMatchObject({
        id: ACCOUNT_ID,
      });
      for (const actor of [COLLEAGUE, null]) {
        const refusal = await policy.validateSelection("openai", ACCOUNT_ID, actor).then(
          () => null,
          (cause: unknown) => cause
        );
        expect(refusal).toBeInstanceOf(ProviderAccountSelectionPolicyError);
        expect((refusal as ProviderAccountSelectionPolicyError).status).toBe(403);
      }
      await expect(policy.validateDefault("openai", ACCOUNT_ID, COLLEAGUE)).rejects.toMatchObject({
        status: 403,
      });
    });

    it("refuses an account whose owner is unknown to everyone", async () => {
      const accounts = new ModelProviderAccountStore(store);
      await accounts.create({ id: ACCOUNT_ID, provider: "xai", displayName: "Legacy" });
      await expect(accounts.getById(ACCOUNT_ID)).resolves.toMatchObject({ ownerUserId: null });
      await expect(
        new ProviderAccountSelectionPolicy(accounts, adapters).validateSelection(
          "xai",
          ACCOUNT_ID,
          OWNER
        )
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        new ProviderDefaultStore(store).set("xai", ACCOUNT_ID, "provider_account", OWNER)
      ).rejects.toThrow(/unattended runs cannot spend/i);
    });
  });
});
