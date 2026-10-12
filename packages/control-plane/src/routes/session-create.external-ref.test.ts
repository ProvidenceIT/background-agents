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
import { EXTERNAL_REF_PENDING_LEASE_MS } from "../session/external-ref";
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
const BODY = { model: MODEL, harness: "claude", title: "Work item 123", externalRef: "wi-123:1" };

type Caller = { kind: "user" } | { kind: "service"; service: ServiceName };
const MOTION: Caller = { kind: "service", service: "motion" };

describe("POST /sessions with an externalRef", () => {
  let store: NodeSqlDatabase;
  let runtimeInits: string[];
  let initialized: Set<string>;
  let probe: "real" | "throw" | "error";

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
    probe = "real";
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

  function post(userId: string, body: Record<string, unknown>, caller: Caller = MOTION) {
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
        if (path === SessionInternalPaths.state) {
          if (probe === "throw") throw new Error("runtime unreachable");
          if (probe === "error") return new Response("boom", { status: 500 });
          return initialized.has(sessionId)
            ? Response.json({ id: sessionId })
            : new Response("Session not found", { status: 404 });
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

  async function refRows() {
    const { results } = await store
      .prepare(
        `SELECT id, user_id, status, spawn_source, external_ref_service, external_ref
         FROM sessions ORDER BY created_at`
      )
      .all<Record<string, unknown>>();
    return results;
  }

  it("creates once and replays the same session on a retry", async () => {
    const first = await post(OWNER, BODY);
    expect(first.status).toBe(201);
    const created = (await first.json()) as { sessionId: string };
    expect(created).toMatchObject({ status: "created", replayed: false });

    const retry = await post(OWNER, BODY);
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({
      sessionId: created.sessionId,
      status: "created",
      replayed: true,
    });
    expect(runtimeInits).toEqual([created.sessionId]);
    expect(await refRows()).toEqual([
      {
        id: created.sessionId,
        user_id: OWNER,
        status: "created",
        spawn_source: "motion",
        external_ref_service: "motion",
        external_ref: "wi-123:1",
      },
    ]);
  });

  it("keeps today's response without an externalRef", async () => {
    const { externalRef: _ref, ...body } = BODY;
    const response = await post(OWNER, body);
    expect(response.status).toBe(201);
    expect(await response.json()).not.toHaveProperty("replayed");
  });

  it("refuses the ref for another actor without revealing the session", async () => {
    expect((await post(OWNER, BODY)).status).toBe(201);

    const response = await post(OTHER, BODY);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Conflict",
      code: "external_ref_conflict",
    });
    expect(await refRows()).toHaveLength(1);
  });

  it("refuses the ref with a different body", async () => {
    expect((await post(OWNER, BODY)).status).toBe(201);

    const response = await post(OWNER, { ...BODY, title: "Something else" });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Conflict",
      code: "external_ref_payload_mismatch",
    });
  });

  it("keeps each service's refs apart", async () => {
    expect((await post(OWNER, BODY)).status).toBe(201);
    expect((await post(OWNER, BODY, { kind: "service", service: "teams-bot" })).status).toBe(201);
    expect(await refRows()).toHaveLength(2);
  });

  it("refuses an externalRef from a person", async () => {
    const response = await post(OWNER, BODY, { kind: "user" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "externalRef is only accepted from a service",
      code: "external_ref_not_allowed",
    });
    expect(await refRows()).toHaveLength(0);
  });

  it("refuses an invalid ref", async () => {
    const response = await post(OWNER, { ...BODY, externalRef: "has space" });
    expect(response.status).toBe(400);
    expect(await refRows()).toHaveLength(0);
  });

  it("releases a first attempt whose runtime init failed and creates afresh", async () => {
    expect((await post(OWNER, BODY)).status).toBe(201);
    const [{ id: firstId }] = await refRows();
    await store.prepare("UPDATE sessions SET status = 'failed' WHERE id = ?").bind(firstId).run();

    const retry = await post(OWNER, BODY);
    expect(retry.status).toBe(201);
    const { sessionId } = (await retry.json()) as { sessionId: string };
    expect(sessionId).not.toBe(firstId);
    const rows = await refRows();
    expect(rows.find((row) => row.id === firstId)).toMatchObject({
      status: "failed",
      external_ref: null,
      external_ref_service: null,
    });
    expect(rows.find((row) => row.id === sessionId)).toMatchObject({ external_ref: "wi-123:1" });
  });

  it("answers in progress while a first attempt without a runtime is within its lease", async () => {
    expect((await post(OWNER, BODY)).status).toBe(201);
    initialized.clear();

    const retry = await post(OWNER, BODY);
    expect(retry.status).toBe(409);
    expect(retry.headers.get("Retry-After")).toBe("5");
    await expect(retry.json()).resolves.toEqual({
      error: "Conflict",
      code: "external_ref_in_progress",
    });
  });

  it("releases a first attempt without a runtime once its lease has passed", async () => {
    expect((await post(OWNER, BODY)).status).toBe(201);
    const [{ id: firstId }] = await refRows();
    initialized.clear();
    await store
      .prepare("UPDATE sessions SET created_at = ? WHERE id = ?")
      .bind(Date.now() - EXTERNAL_REF_PENDING_LEASE_MS - 1, firstId)
      .run();

    const retry = await post(OWNER, BODY);
    expect(retry.status).toBe(201);
    expect(((await retry.json()) as { sessionId: string }).sessionId).not.toBe(firstId);
  });

  it.each(["throw", "error"] as const)(
    "answers indeterminate when the runtime probe fails (%s)",
    async (failure) => {
      expect((await post(OWNER, BODY)).status).toBe(201);
      probe = failure;

      const retry = await post(OWNER, BODY);
      expect(retry.status).toBe(503);
      expect(retry.headers.get("Retry-After")).toBe("5");
      await expect(retry.json()).resolves.toMatchObject({ code: "external_ref_indeterminate" });
    }
  );

  it("replays a session the runtime has claimed without probing it", async () => {
    expect((await post(OWNER, BODY)).status).toBe(201);
    const [{ id }] = await refRows();
    await store
      .prepare("UPDATE sessions SET status = 'completed', status_revision = 3 WHERE id = ?")
      .bind(id)
      .run();
    probe = "throw";

    const retry = await post(OWNER, BODY);
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({
      sessionId: id,
      status: "completed",
      replayed: true,
    });
  });

  it("replays the winner when a concurrent attempt took the ref first", async () => {
    const results = await Promise.all([post(OWNER, BODY), post(OWNER, BODY)]);
    const statuses = results.map((response) => response.status).sort();
    expect([
      [200, 201],
      [201, 409],
    ]).toContainEqual(statuses);
    expect(await refRows()).toHaveLength(1);
    expect(runtimeInits).toHaveLength(1);
  });
});
