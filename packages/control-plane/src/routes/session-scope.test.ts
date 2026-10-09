import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import { HOUSEHOLD, seedHousehold } from "../auth-homes/auth-homes.test-support";
import { UserAuthHomeStore } from "../auth-homes/store";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase } from "../node/sqlite-database";
import {
  authorizationDatabase,
  createTestEnv,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import { sessionScopeRoutes } from "./session-scope";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const handleRequest = createTestRequestHandler([sessionScopeRoutes]);

async function createHouseholdFixture() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(
    sqlite,
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
  );
  const db = createNodeSqlDatabase(sqlite);
  return { ...(await seedHousehold(db)), close: () => db.close() };
}

describe("session scope on an auth-home session", () => {
  let fixture: Awaited<ReturnType<typeof createHouseholdFixture>>;

  beforeEach(async () => {
    fixture = await createHouseholdFixture();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: HOUSEHOLD.owner },
      request,
    }));
  });
  afterEach(() => fixture.close());

  function call(method: string, path: string, body?: unknown) {
    const env = createTestEnv({
      ...TEST_SERVICE_SECRETS,
      DB: authorizationDatabase({
        userId: HOUSEHOLD.owner,
        statement: (sql) => fixture.db.prepare(sql),
        batch: (statements) => fixture.db.batch(statements),
      }),
    });
    return handleRequest(
      new Request(`https://test.local${path}`, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      TEST_BACKGROUND_TASK_CONTEXT
    );
  }

  const visibilityPath = `/sessions/${HOUSEHOLD.sessionId}/visibility`;
  const collaboratorPath = `/sessions/${HOUSEHOLD.sessionId}/collaborators/${HOUSEHOLD.colleague}`;

  it("lets a shared home's session be widened under household", async () => {
    const response = await call("PUT", visibilityPath, { visibility: "workspace" });
    expect(response.status).toBe(200);
    expect((await call("PUT", collaboratorPath)).status).toBe(200);
  });

  it("answers 409 for widening under owner_only, and still lets the owner narrow it", async () => {
    await fixture.setPolicy("owner_only");
    const widened = await call("PUT", visibilityPath, { visibility: "workspace" });
    expect(widened.status).toBe(409);
    expect(await widened.json()).toMatchObject({ code: "auth_home_not_shared" });

    const collaborator = await call("PUT", collaboratorPath);
    expect(collaborator.status).toBe(409);

    expect((await call("PUT", visibilityPath, { visibility: "private" })).status).toBe(200);
  });

  it("answers 409 under household while the home is not shared", async () => {
    await new UserAuthHomeStore(fixture.db).update(HOUSEHOLD.homeId, {
      shared: false,
      sharingConsentAt: null,
    });
    expect((await call("PUT", visibilityPath, { visibility: "workspace" })).status).toBe(409);
  });
});
