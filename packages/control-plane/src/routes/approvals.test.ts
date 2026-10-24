import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceName } from "@open-inspect/shared/service-auth";
import { runApprovalExpiryJob } from "../approvals/expiry";
import { registerApprovalHandler, registerApprovalNotifier } from "../approvals/registry";
import type * as AuthenticateModule from "../auth/authenticate";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import type { Logger } from "../logger";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import {
  createTestEnv,
  createTestRequestHandler,
  signedServiceRequest,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import { approvalRoutes } from "./approvals";

const USER_HEADER = "x-test-user";
vi.mock("../auth/authenticate", async (importOriginal) => {
  const actual = await importOriginal<typeof AuthenticateModule>();
  return {
    ...actual,
    authenticate: vi.fn(async (...args: Parameters<typeof actual.authenticate>) => {
      const userId = args[0].headers.get(USER_HEADER);
      return userId
        ? { principal: { kind: "user", userId }, request: args[0] }
        : actual.authenticate(...args);
    }),
  };
});

const { onMerge, notifier } = vi.hoisted(() => ({
  onMerge: vi.fn(async () => {}),
  notifier: { name: "test", onCreated: vi.fn(async () => {}), onDecided: vi.fn(async () => {}) },
}));
registerApprovalHandler("merge", onMerge);
registerApprovalNotifier(notifier);

const MIGRATIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../terraform/d1/migrations"
);
const BASE = "https://test.local";
const ALICE = "a".repeat(32);
const BOB = "b".repeat(32);
const CAROL = "c".repeat(32);
const VIEWER = "d".repeat(32);

const handleRequest = createTestRequestHandler([approvalRoutes]);

const createBody = (overrides: Record<string, unknown> = {}) => ({
  kind: "merge",
  subjectRef: { repo: "acme/web", pr: 7 },
  title: "Merge acme/web#7",
  responders: { userIds: [ALICE, BOB, VIEWER], teamId: null, role: null },
  digest: "sha-1",
  occurrenceKey: "merge:acme/web#7:sha-1",
  ...overrides,
});

describe("approval routes", () => {
  let sqlite: NodeSqlDatabase;
  let tasks: ReturnType<typeof createTestBackgroundTasks>;

  const send = async (request: Request) => {
    const response = await handleRequest(
      request,
      createTestEnv({ ...TEST_SERVICE_SECRETS, DB: sqlite }),
      tasks
    );
    await tasks.settle();
    return response;
  };
  const asUser = (userId: string, method: string, path: string, body?: unknown) =>
    send(
      new Request(`${BASE}${path}`, {
        method,
        headers: { [USER_HEADER]: userId, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    );
  const asService = async (service: ServiceName, method: string, path: string, body?: unknown) =>
    send(
      await signedServiceRequest(`${BASE}${path}`, {
        method,
        service,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    );
  const create = async (overrides: Record<string, unknown> = {}) => {
    const response = await asService("github-bot", "POST", "/approvals", createBody(overrides));
    expect(response.status).toBe(201);
    return ((await response.json()) as { request: { id: string } }).request.id;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tasks = createTestBackgroundTasks();
    const raw = new DatabaseSync(":memory:");
    applyMigrations(raw, MIGRATIONS);
    sqlite = createNodeSqlDatabase(raw);
    // The users trigger assigns every new user the Member role, which holds approvals.decide.
    for (const id of [ALICE, BOB, CAROL, VIEWER]) {
      await sqlite
        .prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?, 1, 1)")
        .bind(id)
        .run();
    }
    await sqlite
      .prepare("UPDATE user_role_assignments SET role_id = 'role_builtin_viewer' WHERE user_id = ?")
      .bind(VIEWER)
      .run();
  });
  afterEach(() => sqlite.close());

  describe("POST /approvals", () => {
    it("creates for a signed service and returns the existing request for a repeated occurrence key", async () => {
      const first = await asService("github-bot", "POST", "/approvals", createBody());
      expect(first.status).toBe(201);
      const created = (await first.json()) as { request: { id: string; createdBy: string } };
      expect(created.request).toMatchObject({ status: "pending", createdBy: "service:github-bot" });
      expect(notifier.onCreated).toHaveBeenCalledTimes(1);

      const again = await asService(
        "teams-bot",
        "POST",
        "/approvals",
        createBody({ title: "Other" })
      );
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ request: created.request, decisions: [] });
      expect(notifier.onCreated).toHaveBeenCalledTimes(1);
    });

    it("supersedes the subject's pending request when a new digest is requested", async () => {
      const old = await create();
      await create({ digest: "sha-2", occurrenceKey: "merge:acme/web#7:sha-2" });
      const response = await asUser(ALICE, "GET", `/approvals/${old}`);
      expect(await response.json()).toMatchObject({ request: { status: "superseded" } });
    });

    it("refuses users, unsigned callers and invalid bodies", async () => {
      expect((await asUser(ALICE, "POST", "/approvals", createBody())).status).toBe(403);
      const unsigned = await send(
        new Request(`${BASE}/approvals`, { method: "POST", body: JSON.stringify(createBody()) })
      );
      expect(unsigned.status).toBe(401);
      const invalid = await asService(
        "github-bot",
        "POST",
        "/approvals",
        createBody({ responders: { userIds: [], teamId: null, role: null } })
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({
        error: "responders: at least one responder is required",
      });
    });
  });

  describe("POST /approvals/:id/decide", () => {
    it("records a responder's answer once, runs the handler once and notifies", async () => {
      const id = await create();
      const decide = (userId: string, decision: string) =>
        asUser(userId, "POST", `/approvals/${id}/decide`, { decision, note: "looks good" });

      const first = await decide(ALICE, "approve");
      expect(first.status).toBe(200);
      const body = (await first.json()) as { request: unknown; decisions: unknown[] };
      expect(body).toMatchObject({
        request: { id, status: "approved" },
        decisions: [{ userId: ALICE, decision: "approve", note: "looks good", surface: "web" }],
      });

      const repeat = await decide(ALICE, "approve");
      expect(repeat.status).toBe(200);
      expect(await repeat.json()).toEqual(body);

      const changed = await decide(ALICE, "reject");
      expect(changed.status).toBe(409);
      expect(await changed.json()).toEqual({
        error: "Approval request is approved",
        code: "approval_settled",
        status: "approved",
      });
      expect((await decide(BOB, "approve")).status).toBe(409);

      expect(onMerge).toHaveBeenCalledTimes(1);
      expect(onMerge).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({ id, status: "approved" }),
          decision: expect.objectContaining({ userId: ALICE, decision: "approve" }),
        }),
        {
          db: expect.anything(),
          env: expect.objectContaining({ DB: sqlite }),
          log: expect.anything(),
        }
      );
      expect(notifier.onDecided).toHaveBeenCalledTimes(1);
    });

    it("refuses a non-responder, a user without approvals.decide and an answer outside the choices", async () => {
      const id = await create();
      const nonResponder = await asUser(CAROL, "POST", `/approvals/${id}/decide`, {
        decision: "approve",
      });
      expect(nonResponder.status).toBe(403);
      expect(await nonResponder.json()).toEqual({
        error: "Not a responder for this request",
        code: "not_a_responder",
      });
      expect(
        (await asUser(VIEWER, "POST", `/approvals/${id}/decide`, { decision: "approve" })).status
      ).toBe(403);
      expect(
        (await asUser(ALICE, "POST", `/approvals/${id}/decide`, { decision: "send_back" })).status
      ).toBe(400);
      expect(
        (await asUser(ALICE, "POST", "/approvals/missing/decide", { decision: "approve" })).status
      ).toBe(404);
      expect(onMerge).not.toHaveBeenCalled();
      expect(notifier.onDecided).not.toHaveBeenCalled();
    });

    it("refuses an expired request and runs no handler, before or after the sweep", async () => {
      const lapsed = await create({ expiresAt: 1 });
      const response = await asUser(ALICE, "POST", `/approvals/${lapsed}/decide`, {
        decision: "approve",
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ status: "expired" });

      const swept = await create({
        subjectRef: { pr: 8 },
        occurrenceKey: "merge:8",
        expiresAt: 5_000,
      });
      const log = { info: vi.fn() } as unknown as Logger;
      await runApprovalExpiryJob(sqlite, log, 5_000);
      expect(log.info).toHaveBeenCalledWith("approval.expired", { requests: 1 });
      const read = await asUser(ALICE, "GET", `/approvals/${swept}`);
      expect(await read.json()).toMatchObject({ request: { status: "expired" }, decisions: [] });
      expect(onMerge).not.toHaveBeenCalled();
      expect(notifier.onDecided).not.toHaveBeenCalled();
    });
  });

  describe("POST /internal/approvals/:id/decide", () => {
    const path = (id: string) => `/internal/approvals/${id}/decide`;

    it("records the tapping user's answer through teams-bot and notifies like any surface", async () => {
      const id = await create();
      const response = await asService("teams-bot", "POST", path(id), {
        decision: "reject",
        actingUserId: BOB,
        surface: "teams",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        request: { status: "rejected" },
        decisions: [{ userId: BOB, decision: "reject", surface: "teams" }],
      });
      expect(onMerge).toHaveBeenCalledTimes(1);
      expect(notifier.onDecided).toHaveBeenCalledTimes(1);
      expect(notifier.onDecided).toHaveBeenCalledWith(
        expect.objectContaining({ decision: expect.objectContaining({ surface: "teams" }) }),
        expect.anything()
      );

      const audit = await sqlite
        .prepare(
          "SELECT principal_kind, actor_user_id_snapshot, actor_service_snapshot FROM authorization_audit_events WHERE action = 'approval.decided'"
        )
        .all();
      expect(audit.results).toEqual([
        {
          principal_kind: "service",
          actor_user_id_snapshot: BOB,
          actor_service_snapshot: "teams-bot",
        },
      ]);
    });

    it("applies the responder and permission rules to the acting user", async () => {
      const id = await create();
      const asTeams = (actingUserId: string) =>
        asService("teams-bot", "POST", path(id), {
          decision: "approve",
          actingUserId,
          surface: "teams",
        });
      const nonResponder = await asTeams(CAROL);
      expect(nonResponder.status).toBe(403);
      expect(await nonResponder.json()).toEqual({
        error: "Not a responder for this request",
        code: "not_a_responder",
      });
      const viewer = await asTeams(VIEWER);
      expect(viewer.status).toBe(403);
      expect(await viewer.json()).toEqual({
        error: "Acting user may not decide approvals",
        code: "permission_required",
      });
      expect((await asTeams("f".repeat(32))).status).toBe(403);
      expect(onMerge).not.toHaveBeenCalled();
    });

    it("requires a valid teams-bot signature", async () => {
      const id = await create();
      const body = JSON.stringify({ decision: "approve", actingUserId: ALICE, surface: "teams" });
      const unsigned = await send(new Request(`${BASE}${path(id)}`, { method: "POST", body }));
      expect(unsigned.status).toBe(401);

      const signed = await signedServiceRequest(`${BASE}${path(id)}`, {
        method: "POST",
        service: "teams-bot",
        body,
      });
      const tampered = new Request(signed, {
        body: JSON.stringify({ decision: "approve", actingUserId: BOB, surface: "teams" }),
      });
      expect((await send(tampered)).status).toBe(401);

      expect((await asUser(ALICE, "POST", path(id), JSON.parse(body))).status).toBe(403);
      expect((await asService("github-bot", "POST", path(id), JSON.parse(body))).status).toBe(403);
      expect(onMerge).not.toHaveBeenCalled();
    });
  });

  describe("GET /approvals", () => {
    it("lists and reads only the requests the user may answer", async () => {
      const mine = await create();
      await create({
        subjectRef: { pr: 8 },
        occurrenceKey: "merge:8",
        responders: { userIds: [BOB], teamId: null, role: null },
      });
      const listed = await asUser(ALICE, "GET", "/approvals?status=pending");
      expect(listed.status).toBe(200);
      expect(
        ((await listed.json()) as { requests: { id: string }[] }).requests.map((r) => r.id)
      ).toEqual([mine]);
      expect((await asUser(ALICE, "GET", "/approvals?status=bogus")).status).toBe(400);
      expect((await asUser(CAROL, "GET", `/approvals/${mine}`)).status).toBe(404);
      expect((await asUser(ALICE, "GET", `/approvals/${mine}`)).status).toBe(200);
    });
  });
});
