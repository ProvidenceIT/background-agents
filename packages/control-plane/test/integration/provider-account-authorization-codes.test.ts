import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderCredentialStore } from "../../src/db/provider-account-credentials";
import type { AnthropicProviderCredential } from "../../src/auth/model-provider-account-anthropic-adapter";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

/**
 * A Claude subscription is read by the Claude CLI from the subscriber's auth
 * home; the control plane refuses to become a store for it. Every route that
 * would persist an Anthropic token answers 422 `subscription_token_not_storable`
 * before touching the provider or the database. The authorization-code
 * service itself stays covered by its unit tests.
 */

const ACCOUNT_ID = "44".repeat(16);
const USER_ID = "11111111111111111111111111111111";
const BASE = "/model-provider-accounts/anthropic/authorization-codes";
const TRANSACTION_ID = "ab".repeat(32);
const REFUSAL = {
  error: expect.stringContaining("not stored by the control plane"),
  code: "subscription_token_not_storable",
};

async function request(path: string, method: string, body?: unknown): Promise<Response> {
  return serviceFetch(`https://test.local${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    count: number;
  }>();
  return row?.count ?? -1;
}

function credentials(): ProviderCredentialStore {
  return new ProviderCredentialStore(env.DB, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!);
}

/** An Anthropic account connected before the refusal, with the token it stored then. */
async function seedAccount(status = "reconnect_required"): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO model_provider_accounts
      (id, provider, display_name, external_account_id, status, owner_user_id, created_at, updated_at)
     VALUES (?, 'anthropic', 'Preserved Claude', NULL, ?, ?, ?, ?)`
  )
    .bind(ACCOUNT_ID, status, USER_ID, now, now)
    .run();
  await credentials().create({
    providerAccountId: ACCOUNT_ID,
    provider: "anthropic",
    credentialSchemaVersion: 1,
    payload: {
      kind: "setup_token",
      token: "sk-ant-oat01-old",
      expiresAt: now + 1_000,
      scopes: ["user:inference"],
    } satisfies AnthropicProviderCredential,
    now,
  });
}

describe("provider account authorization-code routes", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("refuses to start a paste-back authorization for Anthropic and opens no transaction", async () => {
    const response = await request(BASE, "POST", {
      operation: "create",
      displayName: "Primary Claude",
    });
    expect(response.status).toBe(422);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual(REFUSAL);
    expect(await count("model_provider_account_authorizations")).toBe(0);
    expect(await count("model_provider_accounts")).toBe(0);
  });

  it("refuses the status, completion and cancellation routes the same way", async () => {
    for (const [method, path, body] of [
      ["GET", `${BASE}/${TRANSACTION_ID}`, undefined],
      ["POST", `${BASE}/${TRANSACTION_ID}/complete`, { code: "integration-anthropic-code" }],
      ["DELETE", `${BASE}/${TRANSACTION_ID}`, undefined],
    ] as const) {
      const response = await request(path, method, body);
      expect(response.status, `${method} ${path}`).toBe(422);
      await expect(response.json()).resolves.toEqual(REFUSAL);
    }
  });

  it("refuses a pasted setup token on create and on reconnect, leaving the stored credential alone", async () => {
    await seedAccount();
    const before = await credentials().readCredentialState(ACCOUNT_ID, "anthropic");

    const created = await request("/model-provider-accounts", "POST", {
      provider: "anthropic",
      displayName: "Second Claude",
      setupToken: "sk-ant-oat01-new",
    });
    expect(created.status).toBe(422);
    await expect(created.json()).resolves.toEqual(REFUSAL);
    expect(await count("model_provider_accounts")).toBe(1);

    const reconnected = await request(`/model-provider-accounts/${ACCOUNT_ID}/reconnect`, "POST", {
      provider: "anthropic",
      setupToken: "sk-ant-oat01-new",
    });
    expect(reconnected.status).toBe(422);
    await expect(reconnected.json()).resolves.toEqual(REFUSAL);
    await expect(credentials().readCredentialState(ACCOUNT_ID, "anthropic")).resolves.toEqual(
      before
    );
  });

  it("refuses device authorization for Anthropic and authorization codes for OpenAI as before", async () => {
    const device = await request(
      "/model-provider-accounts/anthropic/device-authorizations",
      "POST",
      { operation: "create", displayName: "Claude" }
    );
    expect(device.status).toBe(409);
    const code = await request("/model-provider-accounts/openai/authorization-codes", "POST", {
      operation: "create",
      displayName: "OpenAI",
    });
    expect(code.status).toBe(409);
  });

  it("still refuses to verify a connected Anthropic account against the provider", async () => {
    await seedAccount("active");
    const response = await request(`/model-provider-accounts/${ACCOUNT_ID}/verify`, "POST");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/cannot be verified/),
    });
    expect((await credentials().readCredentialState(ACCOUNT_ID, "anthropic"))?.exchangeState).toBe(
      "idle"
    );
  });

  it("lists a preserved Anthropic account with its owner and no credential material", async () => {
    await seedAccount("active");
    const response = await request("/model-provider-accounts?provider=anthropic", "GET");
    expect(response.status).toBe(200);
    const body = await response.json<{ accounts: Record<string, unknown>[] }>();
    expect(body.accounts).toEqual([
      expect.objectContaining({ id: ACCOUNT_ID, provider: "anthropic", ownerUserId: USER_ID }),
    ]);
    expect(JSON.stringify(body)).not.toContain("sk-ant");
  });
});
