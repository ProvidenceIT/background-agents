import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceName } from "@open-inspect/shared/service-auth";
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
import { SessionInternalPaths } from "../session/contracts";
import { sessionCreateRoutes } from "./session-create";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));
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
const OTHER = "user-other";
const MODEL = "anthropic/claude-sonnet-4-6";

type Caller = { kind: "user" } | { kind: "service"; service: ServiceName };
const HEALTHCHECK: Caller = { kind: "service", service: "healthcheck" };

describe("POST /sessions from the healthcheck service", () => {
  let store: NodeSqlDatabase;
  let runtimeInits: string[];
  let initialized: Set<string>;

  beforeEach(async () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    store = createNodeSqlDatabase(sqlite);
    for (const userId of [OWNER, OTHER]) {
      await store
        .prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, 1, 1)")
        .bind(userId, userId)
        .run();
    }
    runtimeInits = [];
    initialized = new Set();
    mocks.authenticate.mockImplementation(async (request: Request) => {
      const userId = request.headers.get("x-test-user") ?? OWNER;
      const service = request.headers.get("x-test-service") as ServiceName | null;
      return {
        principal: service
          ? {
              kind: "service",
              service,
              actor:
                service === "web"
                  ? null
                  : {
                      provider: "microsoft",
                      providerUserId: `oid-${userId}`,
                      canonicalUserId: userId,
                      participantUserId: `microsoft:oid-${userId}`,
                    },
            }
          : { kind: "user", userId },
        request,
      };
    });
  });
  afterEach(() => store.close());

  function post(userId: string, body: Record<string, unknown>, caller: Caller = HEALTHCHECK) {
    const DB: SqlDatabase = authorizationDatabase({
      userId,
      statement: (sql) => store.prepare(sql),
      batch: (statements) => store.batch(statements),
    });
    const env = createTestEnv({
      ...TEST_SERVICE_SECRETS,
      DB,
      SESSION: fakeSessionRuntimeDispatch(async (request, sessionId) => {
        const path = new URL(request.url).pathname;
        if (path === SessionInternalPaths.init) {
          runtimeInits.push(sessionId);
          initialized.add(sessionId);
          return Response.json({ status: "created" });
        }
        return new Response("unexpected", { status: 500 });
      }),
    });
    return handleRequest(
      new Request("https://test.local/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-test-user": userId,
          ...(caller.kind === "service" ? { "x-test-service": caller.service } : {}),
        },
        body: JSON.stringify(body),
      }),
      env,
      TEST_BACKGROUND_TASK_CONTEXT
    );
  }

  async function sessionRows() {
    const { results } = await store
      .prepare("SELECT repo_owner, spawn_source FROM sessions")
      .all<Record<string, unknown>>();
    return results;
  }

  it("creates an empty session with a title, as the healthcheck spawn source", async () => {
    const response = await post(OWNER, { title: "oi-canary" });
    expect(response.status).toBe(201);
    expect(runtimeInits).toHaveLength(1);
    expect(await sessionRows()).toEqual([{ repo_owner: null, spawn_source: "healthcheck" }]);
  });

  it.each([
    { title: "oi-canary", repoOwner: "acme", repoName: "web" },
    { repositories: [{ repoOwner: "acme", repoName: "web" }] },
    { environmentId: "env-1" },
    { model: MODEL },
    { title: "oi-canary", includePersonalMemories: true },
  ])("refuses any other body: %j", async (body) => {
    const response = await post(OWNER, body as Record<string, unknown>);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "healthcheck may only create an empty session",
      code: "healthcheck_body_refused",
    });
    expect(runtimeInits).toHaveLength(0);
    expect(await sessionRows()).toHaveLength(0);
  });

  it("leaves other services' bodies alone", async () => {
    const response = await post(
      OWNER,
      { title: "x", model: MODEL },
      {
        kind: "service",
        service: "motion",
      }
    );
    expect(response.status).toBe(201);
  });
});
