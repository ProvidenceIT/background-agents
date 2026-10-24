import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROTECTED_PATHS } from "@open-inspect/shared/policy/protected-paths";
import { permissionsForBuiltInRole, type PermissionId } from "@open-inspect/shared/rbac";
import type * as AuthenticateModule from "../auth/authenticate";
import { RepoPathPolicyStore } from "../db/repo-path-policies";
import type { SqlDatabase } from "../db/sql-database";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import {
  authorizationDatabase,
  createTestEnv,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import { repoPathPolicyRoutes } from "./repo-path-policies";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const handleRequest = createTestRequestHandler([repoPathPolicyRoutes]);
const ADMIN = "admin-1";

describe("repo path policy routes", () => {
  let sqlite: NodeSqlDatabase;

  beforeEach(() => {
    const database = new DatabaseSync(":memory:");
    applyMigrations(
      database,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    sqlite = createNodeSqlDatabase(database);
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: ADMIN },
      request,
    }));
  });
  afterEach(() => sqlite.close());

  function call(method: string, path: string, body?: unknown, permissions?: PermissionId[]) {
    const DB: SqlDatabase = authorizationDatabase({
      userId: ADMIN,
      permissions,
      statement: (sql) => sqlite.prepare(sql),
      batch: (statements) => sqlite.batch(statements),
    });
    return handleRequest(
      new Request(`https://test.local${path}`, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
      createTestEnv({ ...TEST_SERVICE_SECRETS, DB }),
      TEST_BACKGROUND_TASK_CONTEXT
    );
  }

  it("returns the defaults and no repo globs before a policy is set", async () => {
    const response = await call("GET", "/repos/Acme/Web/path-policy");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repo: "acme/web",
      defaults: DEFAULT_PROTECTED_PATHS,
      globs: [],
      updatedBy: null,
      updatedAt: null,
    });
  });

  it("stores the repo globs with the editor and serves them back", async () => {
    const put = await call("PUT", "/repos/Acme/Web/path-policy", {
      globs: [{ glob: "infra/**", category: "governance" }],
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      repo: "acme/web",
      globs: [{ glob: "infra/**", category: "governance" }],
      updatedBy: ADMIN,
    });

    const stored = await new RepoPathPolicyStore(sqlite).get("acme", "web");
    expect(stored).toMatchObject({
      repoOwner: "acme",
      repoName: "web",
      globs: [{ glob: "infra/**", category: "governance" }],
      updatedBy: ADMIN,
    });

    const get = await call("GET", "/repos/acme/web/path-policy");
    expect(await get.json()).toMatchObject({
      globs: [{ glob: "infra/**", category: "governance" }],
      updatedBy: ADMIN,
    });
  });

  it("rejects an invalid body without writing", async () => {
    const response = await call("PUT", "/repos/acme/web/path-policy", {
      globs: [{ glob: "infra/**", category: "everything" }],
    });

    expect(response.status).toBe(400);
    expect(await new RepoPathPolicyStore(sqlite).get("acme", "web")).toBeNull();
  });

  it("lets a member read but not change the policy", async () => {
    const member = permissionsForBuiltInRole("member");
    expect(member).not.toContain("repositories.path_policy.manage");
    expect(permissionsForBuiltInRole("administrator")).toContain("repositories.path_policy.manage");

    expect((await call("GET", "/repos/acme/web/path-policy", undefined, member)).status).toBe(200);
    const put = await call(
      "PUT",
      "/repos/acme/web/path-policy",
      { globs: [{ glob: "infra/**", category: "governance" }] },
      member
    );
    expect(put.status).toBe(403);
    expect(await new RepoPathPolicyStore(sqlite).get("acme", "web")).toBeNull();
  });
});
