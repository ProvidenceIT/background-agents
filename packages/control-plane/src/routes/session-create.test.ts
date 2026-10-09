import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import type * as CredentialAuthorityModule from "../source-control/github-credential-authority";
import type * as IdentityModule from "../session/identity";
import type { SqlDatabase } from "../db/sql-database";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import {
  authorizationDatabase,
  createTestEnv,
  createTestRequestHandler,
  fakeSessionRuntimeDispatch,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import { UserAuthHomeStore } from "../auth-homes/store";
import { sessionCreateRoutes } from "./session-create";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));
// SCM enrichment is out of scope here: no linked GitHub account.
vi.mock("../source-control/github-credential-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof CredentialAuthorityModule>()),
  resolveGitHubCredentialAuthority: vi.fn(async () => ({})),
}));
vi.mock("../session/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof IdentityModule>()),
  resolveGitHubEnrichmentForRequest: vi.fn(async () => null),
}));

const handleRequest = createTestRequestHandler([sessionCreateRoutes]);
const OWNER = "user-owner";
const UNENROLLED = "user-unenrolled";
const MODEL = "anthropic/claude-sonnet-4-6";

describe("POST /sessions with auth homes", () => {
  let store: NodeSqlDatabase;
  let runtimeInits: string[];

  beforeEach(async () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    store = createNodeSqlDatabase(sqlite);
    for (const userId of [OWNER, UNENROLLED]) {
      await store
        .prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, 1, 1)")
        .bind(userId, userId)
        .run();
    }
    await new UserAuthHomeStore(store).register({
      id: "H1",
      ownerUserIds: [OWNER],
      pvcName: "sf-home-owner",
      nodeName: "sandbox-node-1",
      providers: ["anthropic", "zai-coding-plan"],
      shared: true,
      sharingConsentAt: 1,
    });
    runtimeInits = [];
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: request.headers.get("x-test-user") ?? OWNER },
      request,
    }));
  });
  afterEach(() => store.close());

  function post(userId: string, body: Record<string, unknown>) {
    const DB: SqlDatabase = authorizationDatabase({
      userId,
      statement: (sql) => store.prepare(sql),
      batch: (statements) => store.batch(statements),
    });
    const env = createTestEnv({
      ...TEST_SERVICE_SECRETS,
      DB,
      SESSION: fakeSessionRuntimeDispatch(async (_request, sessionId) => {
        runtimeInits.push(sessionId);
        return Response.json({ status: "created" });
      }),
    });
    return handleRequest(
      new Request("https://test.local/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-test-user": userId,
          "x-request-id": `req-${userId}`,
        },
        body: JSON.stringify(body),
      }),
      env,
      TEST_BACKGROUND_TASK_CONTEXT
    );
  }

  async function sessionCount() {
    const row = await store.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
    return row?.n ?? 0;
  }

  it("binds the owner's session to their own home and audits the mount", async () => {
    const response = await post(OWNER, { model: MODEL, harness: "claude" });
    expect(response.status).toBe(201);
    const { sessionId } = (await response.json()) as { sessionId: string };

    const row = await store
      .prepare(
        `SELECT trigger_actor_user_id, trigger_kind, work_item_author_user_id, auth_home_id,
                auth_home_selection
         FROM sessions WHERE id = ?`
      )
      .bind(sessionId)
      .first();
    expect(row).toEqual({
      trigger_actor_user_id: OWNER,
      trigger_kind: "prompt",
      work_item_author_user_id: null,
      auth_home_id: "H1",
      auth_home_selection: "own",
    });
    const auth = await store
      .prepare(
        `SELECT provider, auth_mode, provider_account_id, selection_source
         FROM session_model_provider_auth WHERE session_id = ? AND provider = 'anthropic'`
      )
      .bind(sessionId)
      .first();
    expect(auth).toEqual({
      provider: "anthropic",
      auth_mode: "auth_home",
      provider_account_id: null,
      selection_source: "auth_home_own",
    });

    const audits = await store
      .prepare(
        `SELECT actor_user_id_snapshot, resource_id, target_user_id_snapshot, metadata_json
         FROM authorization_audit_events WHERE action = 'credential.auth_home_mounted'`
      )
      .all<{ metadata_json: string }>();
    expect(audits.results).toHaveLength(1);
    expect(audits.results[0]).toMatchObject({
      actor_user_id_snapshot: OWNER,
      resource_id: sessionId,
      target_user_id_snapshot: OWNER,
    });
    expect(JSON.parse(audits.results[0]!.metadata_json)).toMatchObject({
      session: sessionId,
      owner: OWNER,
      trigger_kind: "prompt",
      trigger_actor: OWNER,
      work_item_author: null,
      provider: "anthropic",
    });
    expect(runtimeInits).toEqual([sessionId]);
  });

  it("creates a Codex session on the owner's home, bound to it for OpenAI", async () => {
    await new UserAuthHomeStore(store).update("H1", {
      providers: ["anthropic", "openai", "zai-coding-plan"],
    });

    const response = await post(OWNER, { model: "openai/gpt-6-sol", harness: "codex" });

    expect(response.status).toBe(201);
    const auth = await store
      .prepare(
        "SELECT auth_mode FROM session_model_provider_auth WHERE provider = 'openai' AND session_id = (SELECT id FROM sessions)"
      )
      .first<{ auth_mode: string }>();
    expect(auth).toEqual({ auth_mode: "auth_home" });
    expect(await store.prepare("SELECT harness, auth_home_id FROM sessions").first()).toEqual({
      harness: "codex",
      auth_home_id: "H1",
    });
  });

  it("refuses a Codex session whose home does not carry OpenAI, before anything is created", async () => {
    const response = await post(OWNER, { model: "openai/gpt-6-sol", harness: "codex" });

    expect(response.status).toBe(403);
    expect(await sessionCount()).toBe(0);
  });

  it("refuses a Codex session with no home in force: there is no key to run it on", async () => {
    await new UserAuthHomeStore(store).remove("H1");

    const response = await post(OWNER, { model: "openai/gpt-6-sol", harness: "codex" });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "The Codex harness runs openai only on a subscription home; enrol one under Settings > Subscription homes."
    );
    expect(await sessionCount()).toBe(0);
  });

  it("refuses an unenrolled user with no_eligible_home and creates nothing", async () => {
    const response = await post(UNENROLLED, { model: MODEL, harness: "claude" });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("no_eligible_home");
    expect(body.message).toContain("no eligible subscription home for anthropic");
    expect(await sessionCount()).toBe(0);
    expect(runtimeInits).toEqual([]);

    const blocked = await store
      .prepare(
        `SELECT operation_result, metadata_json FROM authorization_audit_events
         WHERE action = 'credential.unattended_blocked'`
      )
      .all<{ operation_result: string; metadata_json: string }>();
    expect(blocked.results).toHaveLength(1);
    expect(blocked.results[0]!.operation_result).toBe("denied");
    expect(JSON.parse(blocked.results[0]!.metadata_json)).toMatchObject({
      reason: "no_eligible_home",
      trigger_actor: UNENROLLED,
    });
  });

  it("rejects a trigger kind or work-item author sent by a person", async () => {
    const kind = await post(OWNER, { model: MODEL, harness: "claude", triggerKind: "mention" });
    expect(kind.status).toBe(400);
    const author = await post(OWNER, {
      model: MODEL,
      harness: "claude",
      workItemAuthorScmUserId: "42",
    });
    expect(author.status).toBe(400);
    expect(await sessionCount()).toBe(0);
  });

  it("keeps the legacy paths when no home is registered anywhere", async () => {
    await new UserAuthHomeStore(store).remove("H1");
    const response = await post(UNENROLLED, { model: MODEL, harness: "claude" });
    expect(response.status).toBe(201);
    const row = await store
      .prepare("SELECT trigger_actor_user_id, trigger_kind, auth_home_id FROM sessions")
      .first();
    expect(row).toEqual({
      trigger_actor_user_id: UNENROLLED,
      trigger_kind: "prompt",
      auth_home_id: null,
    });
  });
});
