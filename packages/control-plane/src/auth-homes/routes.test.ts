import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
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
import { CODEX_SEAT } from "@open-inspect/shared/types/auth-homes";
import { AuthHomeLeaseStore } from "./lease";
import { authHomeRoutes } from "./routes";
import { AuthHomeClaimStore, UserAuthHomeStore } from "./store";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const handleRequest = createTestRequestHandler([authHomeRoutes]);
const FIXED_NOW = Date.UTC(2026, 9, 9, 12);
type Role = "owner" | "member";
const USER_IDS = { owner: "U1", member: "U2" } as const;
/** What every active user holds; a Member's custom-role stand-in. */
const MEMBER_PERMISSIONS = ["auth_homes.manage_own", "sessions.create", "sessions.read"] as const;

describe("auth-home routes", () => {
  let store: NodeSqlDatabase;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    store = createNodeSqlDatabase(sqlite);
    for (const userId of Object.values(USER_IDS)) {
      await store
        .prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, 1, 1)")
        .bind(userId, userId)
        .run();
    }
    // The operator's assignments: each user's own claim.
    const claims = new AuthHomeClaimStore(store);
    await claims.assign({ pvcName: "sf-home-u1", ownerUserId: USER_IDS.owner, assignedBy: "op" });
    await claims.assign({ pvcName: "sf-home-u2", ownerUserId: USER_IDS.member, assignedBy: "op" });
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: request.headers.get("x-test-user") ?? USER_IDS.owner },
      request,
    }));
  });
  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  function envFor(role: Role) {
    const DB: SqlDatabase = authorizationDatabase({
      userId: USER_IDS[role],
      permissions: role === "member" ? MEMBER_PERMISSIONS : undefined,
      statement: (sql) => store.prepare(sql),
      batch: (statements) => store.batch(statements),
    });
    return createTestEnv({ ...TEST_SERVICE_SECRETS, DB });
  }

  function call(role: Role, method: string, path: string, body?: unknown) {
    return handleRequest(
      new Request(`https://test.local${path}`, {
        method,
        headers: {
          "x-test-user": USER_IDS[role],
          "x-request-id": `req-${role}-${method}-${path}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
      envFor(role),
      TEST_BACKGROUND_TASK_CONTEXT
    );
  }

  async function auditRows(action: string) {
    const rows = await store
      .prepare(
        "SELECT actor_user_id_snapshot, resource_type, resource_id, metadata_json FROM authorization_audit_events WHERE action = ? ORDER BY occurred_at, id"
      )
      .bind(action)
      .all<{
        actor_user_id_snapshot: string;
        resource_type: string;
        resource_id: string;
        metadata_json: string;
      }>();
    return rows.results.map((row) => ({ ...row, metadata: JSON.parse(row.metadata_json) }));
  }

  const registration = {
    pvcName: "sf-home-u1",
    nodeName: "sandbox-node-1",
    providers: ["anthropic", "openai"],
  };

  it("registers the caller's home on PUT, reads it back, and answers 404 for a user without one", async () => {
    const put = await call("owner", "PUT", "/me/auth-home", registration);
    expect(put.status).toBe(200);
    expect(put.headers.get("Cache-Control")).toBe("private, no-store");
    const { home } = (await put.json()) as { home: Record<string, unknown> };
    expect(home).toEqual({
      id: expect.stringMatching(/^ah_[0-9a-f]{32}$/),
      ownerUserIds: ["U1"],
      pvcName: "sf-home-u1",
      nodeName: "sandbox-node-1",
      providers: ["anthropic", "openai"],
      kindsEnabled: ["prompt", "child", "mention", "issue_label", "pr_event", "schedule"],
      backgroundConsentAt: null,
      maxConcurrent: 3,
      shared: false,
      sharingConsentAt: null,
      status: "active",
      claudeExpiresAt: null,
      registeredAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });

    const get = await call("owner", "GET", "/me/auth-home");
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toEqual({ home });

    const other = await call("member", "GET", "/me/auth-home");
    expect(other.status).toBe(404);
    await expect(other.json()).resolves.toEqual({
      error: "No subscription home is registered for you",
    });

    expect(await auditRows("auth_home.registered")).toMatchObject([
      { actor_user_id_snapshot: "U1", resource_type: "auth_home", resource_id: home.id },
    ]);
  });

  it("never takes an owner from the body and refuses a claim outside the sf-home- prefix", async () => {
    const withOwner = await call("owner", "PUT", "/me/auth-home", {
      ...registration,
      ownerUserIds: ["U2"],
    });
    expect(withOwner.status).toBe(400);
    const badClaim = await call("owner", "PUT", "/me/auth-home", {
      ...registration,
      pvcName: "workspace-u1",
    });
    expect(badClaim.status).toBe(400);
    await expect(badClaim.json()).resolves.toEqual({
      error: expect.stringContaining("pvcName"),
    });
    expect(await new UserAuthHomeStore(store).list()).toEqual([]);
  });

  it("registers only a claim an operator assigned to the caller, and never a Codex claim", async () => {
    // Another person's claim, before they register it.
    const someoneElses = await call("member", "PUT", "/me/auth-home", registration);
    expect(someoneElses.status).toBe(403);
    await expect(someoneElses.json()).resolves.toEqual({
      error: expect.stringContaining("not assigned to you"),
    });
    // A claim nobody was assigned.
    const unassigned = await call("member", "PUT", "/me/auth-home", {
      ...registration,
      pvcName: "sf-home-u3",
    });
    expect(unassigned.status).toBe(403);
    // A home's Codex claim is never a home of its own.
    const codex = await call("member", "PUT", "/me/auth-home", {
      ...registration,
      pvcName: "sf-home-u1-codex",
    });
    expect(codex.status).toBe(400);
    expect(await new UserAuthHomeStore(store).list()).toEqual([]);

    // After the owner removes their home, the claim is still theirs.
    expect((await call("owner", "PUT", "/me/auth-home", registration)).status).toBe(200);
    expect((await call("owner", "DELETE", "/me/auth-home")).status).toBe(204);
    expect((await call("member", "PUT", "/me/auth-home", registration)).status).toBe(403);
    expect(await new UserAuthHomeStore(store).list()).toEqual([]);
  });

  it("keeps a registered home's claim fixed", async () => {
    await call("owner", "PUT", "/me/auth-home", registration);
    const switched = await call("owner", "PUT", "/me/auth-home", {
      ...registration,
      pvcName: "sf-home-u2",
    });
    expect(switched.status).toBe(409);
    await expect(switched.json()).resolves.toEqual({
      error: expect.stringContaining("cannot be changed"),
    });
    expect((await new UserAuthHomeStore(store).list()).map((home) => home.pvcName)).toEqual([
      "sf-home-u1",
    ]);
  });

  it("lets only auth_homes.assign assign claims, and never hands a registered home to another", async () => {
    const denied = await call("member", "PUT", "/auth-home-claims/sf-home-u3", {
      ownerUserId: USER_IDS.member,
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ permission: "auth_homes.assign" });

    const assigned = await call("owner", "PUT", "/auth-home-claims/sf-home-u3", {
      ownerUserId: USER_IDS.member,
    });
    expect(assigned.status).toBe(200);
    await expect(assigned.json()).resolves.toEqual({
      claim: {
        pvcName: "sf-home-u3",
        ownerUserId: "U2",
        assignedBy: "U1",
        assignedAt: FIXED_NOW,
      },
    });
    expect(await auditRows("auth_home.claim_assigned")).toMatchObject([
      { actor_user_id_snapshot: "U1", metadata: { from: null, to: "U2", by: "U1" } },
    ]);
    expect(
      (await call("owner", "PUT", "/auth-home-claims/sf-home-u1-codex", { ownerUserId: "U1" }))
        .status
    ).toBe(400);
    expect(
      (await call("owner", "PUT", "/auth-home-claims/sf-home-u4", { ownerUserId: "nobody" })).status
    ).toBe(404);

    await call("owner", "PUT", "/me/auth-home", registration);
    const takeOver = await call("owner", "PUT", "/auth-home-claims/sf-home-u1", {
      ownerUserId: USER_IDS.member,
    });
    expect(takeOver.status).toBe(409);
    expect((await call("owner", "DELETE", "/auth-home-claims/sf-home-u1")).status).toBe(409);
    expect((await new AuthHomeClaimStore(store).get("sf-home-u1"))?.ownerUserId).toBe("U1");

    expect((await call("owner", "DELETE", "/auth-home-claims/sf-home-u3")).status).toBe(204);
    expect((await call("owner", "DELETE", "/auth-home-claims/sf-home-u3")).status).toBe(404);
    expect(await auditRows("auth_home.claim_unassigned")).toMatchObject([
      { metadata: { from: "U2", to: null } },
    ]);
    const listed = await call("owner", "GET", "/auth-home-claims");
    await expect(listed.json()).resolves.toEqual({
      claims: [
        expect.objectContaining({ pvcName: "sf-home-u1", ownerUserId: "U1" }),
        expect.objectContaining({ pvcName: "sf-home-u2", ownerUserId: "U2" }),
      ],
    });
  });

  it("stamps consent on first grant, keeps it on a repeat, clears it on withdrawal, and audits the flips", async () => {
    await call("owner", "PUT", "/me/auth-home", registration);
    vi.setSystemTime(FIXED_NOW + 1_000);
    const shared = await call("owner", "PUT", "/me/auth-home", {
      ...registration,
      backgroundConsent: true,
      shared: true,
    });
    expect(shared.status).toBe(200);
    await expect(shared.json()).resolves.toMatchObject({
      home: {
        backgroundConsentAt: FIXED_NOW + 1_000,
        shared: true,
        sharingConsentAt: FIXED_NOW + 1_000,
        registeredAt: FIXED_NOW,
        updatedAt: FIXED_NOW + 1_000,
      },
    });

    vi.setSystemTime(FIXED_NOW + 2_000);
    const repeated = await call("owner", "PUT", "/me/auth-home", {
      ...registration,
      backgroundConsent: true,
      shared: true,
      maxConcurrent: 1,
    });
    await expect(repeated.json()).resolves.toMatchObject({
      home: { backgroundConsentAt: FIXED_NOW + 1_000, sharingConsentAt: FIXED_NOW + 1_000 },
    });

    vi.setSystemTime(FIXED_NOW + 3_000);
    const withdrawn = await call("owner", "PUT", "/me/auth-home", {
      ...registration,
      backgroundConsent: false,
      shared: false,
    });
    await expect(withdrawn.json()).resolves.toMatchObject({
      home: { backgroundConsentAt: null, shared: false, sharingConsentAt: null },
    });

    expect(await auditRows("auth_home.consent_changed")).toMatchObject([
      {
        metadata: {
          before: { backgroundConsentAt: null },
          after: { backgroundConsentAt: FIXED_NOW + 1_000 },
        },
      },
      {
        metadata: {
          before: { backgroundConsentAt: FIXED_NOW + 1_000 },
          after: { backgroundConsentAt: null },
        },
      },
    ]);
    expect(await auditRows("auth_home.sharing_changed")).toMatchObject([
      { metadata: { from: false, to: true, by: "U1" } },
      { metadata: { from: true, to: false, by: "U1" } },
    ]);
  });

  it("shows the Codex seat of the caller's home, naming only the caller's own sessions", async () => {
    expect((await call("owner", "GET", "/me/auth-home/lease")).status).toBe(404);
    const { home } = (await (await call("owner", "PUT", "/me/auth-home", registration)).json()) as {
      home: { id: string };
    };
    for (const [id, userId] of [
      ["S-mine-running", USER_IDS.owner],
      ["S-colleague", USER_IDS.member],
      ["S-mine-waiting", USER_IDS.owner],
    ]) {
      await store
        .prepare(
          "INSERT INTO sessions (id, user_id, harness, auth_home_id, created_at, updated_at) VALUES (?, ?, 'codex', ?, 1, 1)"
        )
        .bind(id, userId, home.id)
        .run();
    }
    const leases = new AuthHomeLeaseStore(store, () => FIXED_NOW);
    const fence = { listPodsMountingClaim: async () => [], deletePod: async () => {} };
    const seat = (sessionId: string) => ({
      homeId: home.id,
      provider: CODEX_SEAT,
      sessionId,
      claimName: "sf-home-u1-codex",
    });
    await leases.acquire(seat("S-mine-running"), fence);
    await leases.acquire(seat("S-colleague"), fence);
    await leases.acquire(seat("S-mine-waiting"), fence);

    const response = await call("owner", "GET", "/me/auth-home/lease");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      seat: {
        homeId: home.id,
        seat: "codex",
        holder: {
          sessionId: "S-mine-running",
          mine: true,
          acquiredAt: FIXED_NOW,
          heartbeatAt: FIXED_NOW,
          fencing: false,
        },
        waiting: [
          { sessionId: null, mine: false, position: 1, enqueuedAt: FIXED_NOW },
          { sessionId: "S-mine-waiting", mine: true, position: 2, enqueuedAt: FIXED_NOW },
        ],
      },
    });
  });

  it("removes only the caller's home", async () => {
    await call("owner", "PUT", "/me/auth-home", registration);
    expect((await call("member", "DELETE", "/me/auth-home")).status).toBe(404);
    expect(await new UserAuthHomeStore(store).list()).toHaveLength(1);
    expect((await call("owner", "DELETE", "/me/auth-home")).status).toBe(204);
    expect(await new UserAuthHomeStore(store).list()).toEqual([]);
    expect(await auditRows("auth_home.removed")).toHaveLength(1);
    expect((await call("owner", "GET", "/me/auth-home")).status).toBe(404);
  });

  it("lists every home as metadata without volume names for auth_homes.read_all only", async () => {
    await call("owner", "PUT", "/me/auth-home", registration);
    // The list is ordered by registration time; ids are random, so the two
    // registrations must not share an instant.
    vi.setSystemTime(FIXED_NOW + 1);
    await call("member", "PUT", "/me/auth-home", {
      pvcName: "sf-home-u2",
      nodeName: "sandbox-node-1",
      providers: ["anthropic"],
    });

    const denied = await call("member", "GET", "/auth-homes");
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({
      error: "Forbidden",
      code: "permission_required",
      permission: "auth_homes.read_all",
    });

    const listed = await call("owner", "GET", "/auth-homes");
    expect(listed.status).toBe(200);
    const { homes } = (await listed.json()) as { homes: Record<string, unknown>[] };
    expect(homes.map((home) => home.ownerUserIds)).toEqual([["U1"], ["U2"]]);
    for (const home of homes) {
      expect(home).not.toHaveProperty("pvcName");
      expect(JSON.stringify(home)).not.toContain("sf-home-");
    }
  });

  it("lets any active user read the sharing policy and only subscription_sharing.manage change it", async () => {
    const read = await call("member", "GET", "/subscription-sharing");
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual({
      policy: "household",
      updatedBy: null,
      updatedAt: null,
    });

    const denied = await call("member", "PUT", "/subscription-sharing", { policy: "owner_only" });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({
      error: "Forbidden",
      code: "permission_required",
      permission: "subscription_sharing.manage",
    });
    expect(
      (await store.prepare("SELECT COUNT(*) AS count FROM subscription_sharing").first())?.count
    ).toBe(0);

    const changed = await call("owner", "PUT", "/subscription-sharing", { policy: "owner_only" });
    expect(changed.status).toBe(200);
    await expect(changed.json()).resolves.toEqual({
      policy: "owner_only",
      updatedBy: "U1",
      updatedAt: FIXED_NOW,
    });
    expect(await auditRows("subscription_sharing.changed")).toMatchObject([
      {
        actor_user_id_snapshot: "U1",
        resource_type: "subscription_sharing",
        resource_id: "global",
        metadata: {
          from: "household",
          to: "owner_only",
          by: "U1",
          before: { policy: "household" },
          after: { policy: "owner_only" },
        },
      },
    ]);

    // Writing the same policy again changes nothing and audits nothing.
    expect(
      (await call("owner", "PUT", "/subscription-sharing", { policy: "owner_only" })).status
    ).toBe(200);
    expect(await auditRows("subscription_sharing.changed")).toHaveLength(1);
    expect(
      (await call("owner", "PUT", "/subscription-sharing", { policy: "everyone" })).status
    ).toBe(400);
    await expect(
      call("member", "GET", "/subscription-sharing").then((r) => r.json())
    ).resolves.toMatchObject({
      policy: "owner_only",
    });
  });
});
