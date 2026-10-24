import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createApprovalRequestSchema,
  type CreateApprovalRequest,
} from "@open-inspect/shared/types/approvals";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { ApprovalRequestStore, type ApprovalAuditActor } from "./approval-requests";

const MIGRATIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../terraform/d1/migrations"
);
const ALICE = "a".repeat(32);
const BOB = "b".repeat(32);
const CAROL = "c".repeat(32);
const SERVICE_ACTOR: ApprovalAuditActor = {
  requestId: "req-create",
  kind: "service",
  service: "github-bot",
};
const userActor = (userId: string): ApprovalAuditActor => ({
  requestId: `req-${userId.slice(0, 1)}`,
  kind: "user",
  userId,
});

function newRequest(overrides: Partial<Record<keyof CreateApprovalRequest, unknown>> = {}) {
  return {
    ...createApprovalRequestSchema.parse({
      kind: "merge",
      subjectRef: { repo: "acme/web", pr: 7 },
      title: "Merge acme/web#7",
      responders: { userIds: [ALICE, BOB], teamId: null, role: null },
      digest: "sha-1",
      occurrenceKey: "merge:acme/web#7:sha-1",
      ...overrides,
    }),
    createdBy: "service:github-bot",
  };
}

describe("ApprovalRequestStore", () => {
  let sqlite: NodeSqlDatabase;
  let store: ApprovalRequestStore;

  beforeEach(async () => {
    const raw = new DatabaseSync(":memory:");
    applyMigrations(raw, MIGRATIONS);
    sqlite = createNodeSqlDatabase(raw);
    store = new ApprovalRequestStore(sqlite);
  });
  afterEach(() => sqlite.close());

  it("stores a pending request with its canonical subject and audits the creation", async () => {
    const { request, created } = await store.create(
      newRequest({ subjectRef: { pr: 7, repo: "acme/web" } }),
      SERVICE_ACTOR,
      1_000
    );
    expect(created).toBe(true);
    expect(request).toEqual({
      id: expect.any(String),
      kind: "merge",
      subjectRef: { pr: 7, repo: "acme/web" },
      title: "Merge acme/web#7",
      summary: "",
      recommendation: null,
      choices: ["approve", "reject"],
      responders: { userIds: [ALICE, BOB], teamId: null, role: null },
      quorum: 1,
      status: "pending",
      digest: "sha-1",
      occurrenceKey: "merge:acme/web#7:sha-1",
      expiresAt: null,
      createdBy: "service:github-bot",
      followUp: null,
      decidedAt: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    const stored = await sqlite
      .prepare("SELECT subject_ref FROM approval_requests WHERE id = ?")
      .bind(request.id)
      .first<{ subject_ref: string }>();
    expect(stored?.subject_ref).toBe('{"pr":7,"repo":"acme/web"}');
    const audit = await sqlite
      .prepare(
        "SELECT action, principal_kind, actor_service_snapshot, resource_type, resource_id FROM authorization_audit_events WHERE action LIKE 'approval.%'"
      )
      .all();
    expect(audit.results).toEqual([
      {
        action: "approval.requested",
        principal_kind: "service",
        actor_service_snapshot: "github-bot",
        resource_type: "approval_request",
        resource_id: request.id,
      },
    ]);
  });

  it("returns the existing request for a repeated occurrence key, without a second audit row", async () => {
    const first = await store.create(newRequest(), SERVICE_ACTOR, 1_000);
    const again = await store.create(
      newRequest({ title: "Different title" }),
      SERVICE_ACTOR,
      2_000
    );
    expect(again).toEqual({ request: first.request, created: false });
    const count = await sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM authorization_audit_events WHERE action = 'approval.requested'"
      )
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("supersedes the subject's pending requests when a new digest arrives", async () => {
    const old = await store.create(newRequest(), SERVICE_ACTOR, 1_000);
    const otherSubject = await store.create(
      newRequest({ subjectRef: { repo: "acme/web", pr: 8 }, occurrenceKey: "merge:8:sha-1" }),
      SERVICE_ACTOR,
      1_000
    );
    const sameDigest = await store.create(
      newRequest({ occurrenceKey: "merge:acme/web#7:sha-1:again" }),
      SERVICE_ACTOR,
      1_500
    );
    expect((await store.get(old.request.id))?.status).toBe("pending");

    const fresh = await store.create(
      newRequest({ digest: "sha-2", occurrenceKey: "merge:acme/web#7:sha-2" }),
      SERVICE_ACTOR,
      2_000
    );
    expect(fresh.request.status).toBe("pending");
    expect(await store.get(old.request.id)).toMatchObject({
      status: "superseded",
      updatedAt: 2_000,
    });
    expect((await store.get(sameDigest.request.id))?.status).toBe("superseded");
    expect((await store.get(otherSubject.request.id))?.status).toBe("pending");
  });

  it("records the first answer once: the same answer again is unchanged, a different one conflicts", async () => {
    const { request } = await store.create(newRequest(), SERVICE_ACTOR, 1_000);
    const answer = { userId: ALICE, decision: "approve", note: "ship it", surface: "web" } as const;

    const first = await store.decide(request.id, answer, userActor(ALICE), 2_000);
    expect(first).toEqual({
      kind: "decided",
      request: { ...request, status: "approved", decidedAt: 2_000, updatedAt: 2_000 },
      decision: {
        id: expect.any(String),
        requestId: request.id,
        userId: ALICE,
        decision: "approve",
        note: "ship it",
        surface: "web",
        decidedAt: 2_000,
      },
    });
    if (first.kind !== "decided") throw new Error("unreachable");

    const repeat = await store.decide(
      request.id,
      { ...answer, surface: "teams" },
      userActor(ALICE),
      3_000
    );
    expect(repeat).toEqual({ kind: "unchanged", request: first.request, decision: first.decision });

    const changedMind = await store.decide(
      request.id,
      { ...answer, decision: "reject" },
      userActor(ALICE),
      3_000
    );
    expect(changedMind).toEqual({ kind: "conflict", request: first.request });
    const other = await store.decide(request.id, { ...answer, userId: BOB }, userActor(BOB), 3_000);
    expect(other).toEqual({ kind: "conflict", request: first.request });

    expect(await store.listDecisions(request.id)).toEqual([first.decision]);
    const audit = await sqlite
      .prepare(
        "SELECT actor_user_id_snapshot AS actor, metadata_json FROM authorization_audit_events WHERE action = 'approval.decided'"
      )
      .all<{ actor: string; metadata_json: string }>();
    expect(audit.results.map((row) => [row.actor, JSON.parse(row.metadata_json)])).toEqual([
      [
        ALICE,
        {
          before: { status: "pending" },
          requested: { decision: "approve", surface: "web" },
          after: { status: "approved", decision: "approve", decidedBy: ALICE },
        },
      ],
    ]);
  });

  it("maps send_back and reject to their settled statuses", async () => {
    const sendBack = await store.create(
      newRequest({ choices: ["approve", "send_back"] }),
      SERVICE_ACTOR,
      1
    );
    const reject = await store.create(
      newRequest({ subjectRef: { pr: 9 }, occurrenceKey: "merge:9" }),
      SERVICE_ACTOR,
      1
    );
    const base = { userId: BOB, note: null, surface: "api" } as const;
    expect(
      await store.decide(sendBack.request.id, { ...base, decision: "send_back" }, userActor(BOB), 5)
    ).toMatchObject({ kind: "decided", request: { status: "sent_back" } });
    expect(
      await store.decide(reject.request.id, { ...base, decision: "reject" }, userActor(BOB), 5)
    ).toMatchObject({ kind: "decided", request: { status: "rejected" } });
  });

  it("refuses answers to a superseded request", async () => {
    const old = await store.create(newRequest(), SERVICE_ACTOR, 1_000);
    await store.create(newRequest({ digest: "sha-2", occurrenceKey: "k2" }), SERVICE_ACTOR, 2_000);
    const result = await store.decide(
      old.request.id,
      { userId: ALICE, decision: "approve", note: null, surface: "web" },
      userActor(ALICE),
      3_000
    );
    expect(result).toMatchObject({ kind: "conflict", request: { status: "superseded" } });
    expect(await store.listDecisions(old.request.id)).toEqual([]);
  });

  it("expires due requests in the sweep and refuses a late answer before the sweep runs", async () => {
    const due = await store.create(newRequest({ expiresAt: 5_000 }), SERVICE_ACTOR, 1_000);
    const later = await store.create(
      newRequest({ subjectRef: { pr: 2 }, occurrenceKey: "later", expiresAt: 9_000 }),
      SERVICE_ACTOR,
      1_000
    );
    const lateAnswer = await store.create(
      newRequest({ subjectRef: { pr: 3 }, occurrenceKey: "late", expiresAt: 5_000 }),
      SERVICE_ACTOR,
      1_000
    );

    expect(
      await store.decide(
        lateAnswer.request.id,
        { userId: ALICE, decision: "approve", note: null, surface: "teams" },
        userActor(ALICE),
        5_000
      )
    ).toMatchObject({ kind: "conflict", request: { status: "expired" } });

    expect(await store.expireDue(4_999)).toBe(0);
    expect(await store.expireDue(5_000)).toBe(1);
    expect(await store.expireDue(5_000)).toBe(0);
    expect((await store.get(due.request.id))?.status).toBe("expired");
    expect((await store.get(later.request.id))?.status).toBe("pending");
    expect(await store.listDecisions(lateAnswer.request.id)).toEqual([]);
  });

  describe("responders", () => {
    let teamId: string;

    beforeEach(async () => {
      for (const id of [ALICE, BOB, CAROL]) {
        await sqlite
          .prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?, 1, 1)")
          .bind(id)
          .run();
      }
      teamId = "team_platform";
      await sqlite
        .prepare(
          "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, 'platform', 'Platform', 1, 1)"
        )
        .bind(teamId)
        .run();
      await sqlite
        .prepare(
          `INSERT INTO team_memberships (team_id, user_id, role, created_at)
           VALUES (?, ?, 'lead', 1), (?, ?, 'member', 1)`
        )
        .bind(teamId, BOB, teamId, CAROL)
        .run();
    });

    it("admits listed users and team members, narrowed by team role", async () => {
      const listed = (await store.create(newRequest(), SERVICE_ACTOR, 1)).request;
      const team = (
        await store.create(
          newRequest({
            subjectRef: { pr: 2 },
            occurrenceKey: "team",
            responders: { userIds: [], teamId, role: null },
          }),
          SERVICE_ACTOR,
          2
        )
      ).request;
      const leads = (
        await store.create(
          newRequest({
            subjectRef: { pr: 3 },
            occurrenceKey: "leads",
            responders: { userIds: [ALICE], teamId, role: "lead" },
          }),
          SERVICE_ACTOR,
          3
        )
      ).request;

      const answers = async (userId: string) =>
        Promise.all([listed, team, leads].map((request) => store.isResponder(request, userId)));
      expect(await answers(ALICE)).toEqual([true, false, true]);
      expect(await answers(BOB)).toEqual([true, true, true]);
      expect(await answers(CAROL)).toEqual([false, true, false]);

      const ids = async (userId: string) =>
        (await store.listForResponder(userId, { status: "pending", limit: 50 })).map(
          (request) => request.id
        );
      expect(await ids(ALICE)).toEqual([leads.id, listed.id]);
      expect(await ids(BOB)).toEqual([leads.id, team.id, listed.id]);
      expect(await ids(CAROL)).toEqual([team.id]);
      expect(await store.listForResponder(CAROL, { status: "approved", limit: 50 })).toEqual([]);
      expect(
        (await store.listForResponder(BOB, { status: null, limit: 1 })).map((r) => r.id)
      ).toEqual([leads.id]);
    });
  });
});
