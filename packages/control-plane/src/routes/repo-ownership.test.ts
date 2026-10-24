import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { permissionsForBuiltInRole } from "@open-inspect/shared/rbac";
import type { SessionToolGate } from "@open-inspect/shared/session-tools";
import type * as AuthenticateModule from "../auth/authenticate";
import { IntegrationSettingsStore } from "../db/integration-settings";
import { RepoMetadataStore } from "../db/repo-metadata";
import type { SqlDatabase } from "../db/sql-database";
import { TeamStore } from "../db/teams";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import {
  authorizationDatabase,
  type AuthorizationDatabaseOptions,
  createTestEnv,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
  TEST_USER_ID,
} from "../router.test-support";
import type { Env } from "../types";
import { handleRepoContext, repoOwnershipRoutes } from "./repo-ownership";
import type { SandboxRouteContext } from "./shared";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const handleRequest = createTestRequestHandler([repoOwnershipRoutes]);
const PILOT = "/repos/ProvidenceIT/background-agents/ownership";
const SESSION = "9f2c4e1a7b3d5f60a1b2c3d4e5f60718";
const REPOLESS_SESSION = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";

describe("repository ownership routes", () => {
  let sqlite: NodeSqlDatabase;
  let teamId: string;

  const database = (permissions?: AuthorizationDatabaseOptions["permissions"]): SqlDatabase =>
    authorizationDatabase({
      permissions,
      statement: (sql) => sqlite.prepare(sql),
      batch: (statements) => sqlite.batch(statements),
    });
  const call = (db: SqlDatabase, method: string, path: string, json?: unknown) =>
    handleRequest(
      new Request(`https://test.local${path}`, {
        method,
        ...(json === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) }),
      }),
      createTestEnv({ ...TEST_SERVICE_SECRETS, DB: db }),
      TEST_BACKGROUND_TASK_CONTEXT
    );
  const body = () => ({
    ownerTeamId: teamId,
    tier: "T1",
    repoClass: "internal",
    domain: "factory",
    dependsOn: ["ProvidenceIT/prompt-library"],
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: TEST_USER_ID },
      request,
    }));
    const raw = new DatabaseSync(":memory:");
    applyMigrations(
      raw,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    sqlite = createNodeSqlDatabase(raw);
    teamId = (
      await new TeamStore(sqlite).create({ slug: "platform", name: "Platform", joinPolicy: "open" })
    ).id;
  });
  afterEach(() => sqlite.close());

  it("lets an Owner set ownership, then read it back and list it", async () => {
    const owner = database();
    const put = await call(owner, "PUT", PILOT, body());
    expect(put.status).toBe(200);
    const ownership = {
      repo: "providenceit/background-agents",
      ownerTeam: { id: teamId, slug: "platform", name: "Platform" },
      tier: "T1",
      repoClass: "internal",
      effectiveRepoClass: "internal",
      domain: "factory",
      dependsOn: ["providenceit/prompt-library"],
      codeowners: null,
      codeownersSyncedAt: null,
    };
    expect(await put.json()).toEqual({ ownership });

    const get = await call(owner, "GET", PILOT);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ ownership });
    expect(await (await call(owner, "GET", "/repo-ownership")).json()).toEqual({
      repos: [ownership],
    });
  });

  it("answers an unknown repository as unowned and unclassified, treated as client", async () => {
    const response = await call(database(), "GET", "/repos/acme/new/ownership");
    expect(await response.json()).toEqual({
      ownership: {
        repo: "acme/new",
        ownerTeam: null,
        tier: null,
        repoClass: null,
        effectiveRepoClass: "client",
        domain: null,
        dependsOn: null,
        codeowners: null,
        codeownersSyncedAt: null,
      },
    });
  });

  it("refuses an unknown class and a team that does not exist", async () => {
    const owner = database();
    const badClass = await call(owner, "PUT", PILOT, { ...body(), repoClass: "public" });
    expect(badClass.status).toBe(400);
    const badTeam = await call(owner, "PUT", PILOT, { ...body(), ownerTeamId: "team-missing" });
    expect(badTeam.status).toBe(400);
    expect(await badTeam.json()).toEqual({ error: "ownerTeamId: no active team has this id" });
    expect(
      await new RepoMetadataStore(sqlite).getOwnership("providenceit", "background-agents")
    ).toBeNull();
  });

  it("returns 403 to a non-admin PUT and lets them read", async () => {
    const member = database(permissionsForBuiltInRole("member"));
    const put = await call(member, "PUT", PILOT, body());
    expect(put.status).toBe(403);
    expect(
      await new RepoMetadataStore(sqlite).getOwnership("providenceit", "background-agents")
    ).toBeNull();
    expect((await call(member, "GET", PILOT)).status).toBe(200);
  });

  describe("repo_context session tool", () => {
    const ctx = () => ({ db: sqlite, request_id: "req-1", trace_id: "trace-1" }) as never;
    const repoContext = (id = SESSION) =>
      handleRepoContext(
        new Request(`https://cp.test/sessions/${id}/repo-context`),
        {} as Env,
        { id },
        ctx() as SandboxRouteContext
      );
    const enable = (tools: SessionToolGate[]) =>
      new IntegrationSettingsStore(sqlite).setGlobal("session-tools", { defaults: { tools } });

    beforeEach(async () => {
      for (const [id, owner, name] of [
        [SESSION, "ProvidenceIT", "background-agents"],
        [REPOLESS_SESSION, null, null],
      ]) {
        await sqlite
          .prepare(
            `INSERT INTO sessions (id, title, repo_owner, repo_name, model, status, created_at, updated_at)
             VALUES (?, 'Pilot work', ?, ?, 'anthropic/claude-sonnet-4-6', 'active', 1, 1)`
          )
          .bind(id, owner, name)
          .run();
      }
      const store = new RepoMetadataStore(sqlite);
      await store.setOwnership("ProvidenceIT", "background-agents", {
        ownerTeamId: teamId,
        tier: "T1",
        repoClass: "internal",
        domain: null,
        dependsOn: null,
      });
      await store.setCodeowners(
        "ProvidenceIT",
        "background-agents",
        [
          { pattern: "*", owners: [{ kind: "team", handle: "@ProvidenceIT/platform" }] },
          {
            pattern: "/terraform/",
            owners: [
              { kind: "user", handle: "@bramdokman" },
              { kind: "team", handle: "@ProvidenceIT/platform" },
            ],
          },
        ],
        Date.UTC(2026, 9, 24, 3)
      );
    });

    it("returns the pilot's owner team, tier, class and CODEOWNERS owners", async () => {
      await enable(["repo_context"]);
      const response = await repoContext();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        repo: "providenceit/background-agents",
        ownerTeam: { slug: "platform", name: "Platform" },
        tier: "T1",
        repoClass: "internal",
        classified: true,
        domain: null,
        dependsOn: [],
        codeowners: {
          defaultOwners: ["@ProvidenceIT/platform"],
          owners: ["@ProvidenceIT/platform", "@bramdokman"],
          syncedAt: "2026-10-24T03:00:00.000Z",
        },
      });
    });

    it("is refused while the gate is closed and for a session without a repository", async () => {
      const closed = await repoContext();
      expect(closed.status).toBe(404);
      expect(await closed.json()).toMatchObject({ reason: "feature_disabled" });

      await enable(["repo_context"]);
      const repoless = await repoContext(REPOLESS_SESSION);
      expect(repoless.status).toBe(409);
      expect(await repoless.json()).toMatchObject({ reason: "no_repository" });
    });
  });
});
