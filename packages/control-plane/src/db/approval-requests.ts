import {
  APPROVAL_DECISION_STATUS,
  APPROVAL_QUORUM,
  approvalDecisionSchema,
  approvalRequestSchema,
  type ApprovalDecision,
  type ApprovalDecisionValue,
  type ApprovalRequest,
  type ApprovalStatus,
  type ApprovalSurface,
  type CreateApprovalRequest,
} from "@open-inspect/shared/types/approvals";
import { canonicalJson } from "../session/external-ref";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlDatabase, SqlStatement } from "./sql-database";

interface ApprovalRequestRow {
  id: string;
  kind: string;
  subject_ref: string;
  title: string;
  summary: string;
  recommendation: string | null;
  choices: string;
  responder_team_id: string | null;
  responder_role: string | null;
  quorum: number;
  status: string;
  digest: string | null;
  occurrence_key: string;
  expires_at: number | null;
  created_by: string;
  follow_up: string | null;
  decided_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ApprovalDecisionRow {
  id: string;
  request_id: string;
  user_id: string;
  decision: string;
  note: string | null;
  surface: string;
  decided_at: number;
}

function requestFromRow(row: ApprovalRequestRow, responderUserIds: string[]): ApprovalRequest {
  return approvalRequestSchema.parse({
    id: row.id,
    kind: row.kind,
    subjectRef: JSON.parse(row.subject_ref),
    title: row.title,
    summary: row.summary,
    recommendation: row.recommendation,
    choices: JSON.parse(row.choices),
    responders: {
      userIds: responderUserIds,
      teamId: row.responder_team_id,
      role: row.responder_role,
    },
    quorum: row.quorum,
    status: row.status,
    digest: row.digest,
    occurrenceKey: row.occurrence_key,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
    followUp: row.follow_up === null ? null : JSON.parse(row.follow_up),
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function decisionFromRow(row: ApprovalDecisionRow): ApprovalDecision {
  return approvalDecisionSchema.parse({
    id: row.id,
    requestId: row.request_id,
    userId: row.user_id,
    decision: row.decision,
    note: row.note,
    surface: row.surface,
    decidedAt: row.decided_at,
  });
}

/** Who caused a write, for its audit row. A service may act for a person (`actingUserId`). */
export type ApprovalAuditActor =
  | { requestId: string; kind: "user"; userId: string }
  | { requestId: string; kind: "service"; service: string; actingUserId?: string };

export interface ApprovalDecisionInput {
  userId: string;
  decision: ApprovalDecisionValue;
  note: string | null;
  surface: ApprovalSurface;
}

/**
 * The result of a decide. Only `decided` changed anything; it is returned to exactly one caller
 * per request, which is the one that runs the follow-up.
 */
export type ApprovalDecideOutcome =
  | { kind: "decided"; request: ApprovalRequest; decision: ApprovalDecision }
  /** The same person already gave the same answer: a retried tap. */
  | { kind: "unchanged"; request: ApprovalRequest; decision: ApprovalDecision }
  /** Settled already by another answer, superseded or expired. */
  | { kind: "conflict"; request: ApprovalRequest }
  | { kind: "not_found" };

const SELECT_REQUEST = "SELECT * FROM approval_requests";

/**
 * Approval requests and their decisions. Every transition is a compare-and-set on
 * `status = 'pending'` inside one atomic batch, and the dependent decision and audit rows apply
 * only when that transition won, so a lost race leaves no side effects.
 */
export class ApprovalRequestStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(id: string): Promise<ApprovalRequest | null> {
    const row = await this.db
      .prepare(`${SELECT_REQUEST} WHERE id = ?`)
      .bind(id)
      .first<ApprovalRequestRow>();
    return row ? ((await this.withResponders([row]))[0] ?? null) : null;
  }

  async getByOccurrenceKey(occurrenceKey: string): Promise<ApprovalRequest | null> {
    const row = await this.db
      .prepare(`${SELECT_REQUEST} WHERE occurrence_key = ?`)
      .bind(occurrenceKey)
      .first<ApprovalRequestRow>();
    return row ? ((await this.withResponders([row]))[0] ?? null) : null;
  }

  async listDecisions(requestId: string): Promise<ApprovalDecision[]> {
    const rows = await this.db
      .prepare("SELECT * FROM approval_decisions WHERE request_id = ? ORDER BY decided_at, id")
      .bind(requestId)
      .all<ApprovalDecisionRow>();
    return rows.results.map(decisionFromRow);
  }

  /**
   * Requests `userId` may answer, newest first: they are listed by id, or they belong to the
   * responder team (in the responder role, when one is set).
   */
  async listForResponder(
    userId: string,
    options: { status: ApprovalStatus | null; limit: number }
  ): Promise<ApprovalRequest[]> {
    const statusFilter = options.status === null ? "" : "r.status = ? AND";
    const rows = await this.db
      .prepare(
        `${SELECT_REQUEST} r
         WHERE ${statusFilter} (
             EXISTS (
               SELECT 1 FROM approval_request_responders rr
               WHERE rr.request_id = r.id AND rr.user_id = ?
             )
             OR EXISTS (
               SELECT 1 FROM team_memberships tm
               WHERE tm.team_id = r.responder_team_id AND tm.user_id = ?
                 AND (r.responder_role IS NULL OR tm.role = r.responder_role)
             )
           )
         ORDER BY r.created_at DESC, r.id DESC LIMIT ?`
      )
      .bind(...(options.status === null ? [] : [options.status]), userId, userId, options.limit)
      .all<ApprovalRequestRow>();
    return this.withResponders(rows.results);
  }

  /** Attach each row's named responders, read in batches within the parameter limit. */
  private async withResponders(rows: ApprovalRequestRow[]): Promise<ApprovalRequest[]> {
    const userIds = new Map<string, string[]>(rows.map((row) => [row.id, []]));
    const ids = [...userIds.keys()];
    for (let offset = 0; offset < ids.length; offset += MAX_D1_QUERY_PARAMETERS) {
      const batch = ids.slice(offset, offset + MAX_D1_QUERY_PARAMETERS);
      const responders = await this.db
        .prepare(
          `SELECT request_id, user_id FROM approval_request_responders
           WHERE request_id IN (${batch.map(() => "?").join(", ")}) ORDER BY request_id, user_id`
        )
        .bind(...batch)
        .all<{ request_id: string; user_id: string }>();
      for (const responder of responders.results) {
        userIds.get(responder.request_id)?.push(responder.user_id);
      }
    }
    return rows.map((row) => requestFromRow(row, userIds.get(row.id) ?? []));
  }

  /** Whether `userId` may answer `request` under its responder rules. */
  async isResponder(request: ApprovalRequest, userId: string): Promise<boolean> {
    const { userIds, teamId, role } = request.responders;
    if (userIds.includes(userId)) return true;
    if (teamId === null) return false;
    const membership = await this.db
      .prepare("SELECT role FROM team_memberships WHERE team_id = ? AND user_id = ?")
      .bind(teamId, userId)
      .first<{ role: string }>();
    return membership !== null && (role === null || membership.role === role);
  }

  /**
   * Insert a request, or return the one already stored under its occurrence key. A new request
   * with a digest supersedes the pending requests of the same kind and subject whose digest
   * differs.
   */
  async create(
    input: CreateApprovalRequest & { createdBy: string },
    actor: ApprovalAuditActor,
    now = Date.now()
  ): Promise<{ request: ApprovalRequest; created: boolean }> {
    const id = crypto.randomUUID();
    const subjectRef = canonicalJson(input.subjectRef);
    const inserted = { sql: "EXISTS (SELECT 1 FROM approval_requests WHERE id = ?)", params: [id] };
    const { userIds, teamId, role } = input.responders;
    const [insert] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO approval_requests
             (id, kind, subject_ref, title, summary, recommendation, choices, responder_team_id,
              responder_role, quorum, status, digest, occurrence_key, expires_at, created_by,
              follow_up, decided_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, ?, ?)
           ON CONFLICT (occurrence_key) DO NOTHING`
        )
        .bind(
          id,
          input.kind,
          subjectRef,
          input.title,
          input.summary,
          input.recommendation,
          JSON.stringify(input.choices),
          teamId,
          role,
          APPROVAL_QUORUM,
          input.digest,
          input.occurrenceKey,
          input.expiresAt,
          input.createdBy,
          input.followUp === null ? null : JSON.stringify(input.followUp),
          now,
          now
        ),
      ...userIds.map((userId) =>
        this.db
          .prepare(
            `INSERT INTO approval_request_responders (request_id, user_id)
             SELECT ?, ? WHERE ${inserted.sql}`
          )
          .bind(id, userId, ...inserted.params)
      ),
      ...(input.digest === null
        ? []
        : [
            this.db
              .prepare(
                `UPDATE approval_requests SET status = 'superseded', updated_at = ?
                 WHERE kind = ? AND subject_ref = ? AND status = 'pending' AND id <> ?
                   AND (digest IS NULL OR digest <> ?) AND ${inserted.sql}`
              )
              .bind(now, input.kind, subjectRef, id, input.digest, ...inserted.params),
          ]),
      this.bindAudit(
        actor,
        {
          action: "approval.requested",
          requestId: id,
          teamId,
          before: {},
          requested: { kind: input.kind, occurrenceKey: input.occurrenceKey },
          after: { status: "pending", kind: input.kind, digest: input.digest },
          now,
        },
        inserted
      ),
    ]);
    if (insert!.meta.changes === 0) {
      const existing = await this.getByOccurrenceKey(input.occurrenceKey);
      if (!existing) throw new Error("Approval request vanished after an occurrence-key conflict");
      return { request: existing, created: false };
    }
    const request = await this.get(id);
    if (!request) throw new Error("Approval request vanished after insert");
    return { request, created: true };
  }

  /**
   * Record one person's answer. The caller has checked that they are a responder and that the
   * answer is one of the request's choices.
   */
  async decide(
    requestId: string,
    input: ApprovalDecisionInput,
    actor: ApprovalAuditActor,
    now = Date.now()
  ): Promise<ApprovalDecideOutcome> {
    const decisionId = crypto.randomUUID();
    const status = APPROVAL_DECISION_STATUS[input.decision];
    const recorded = {
      sql: "EXISTS (SELECT 1 FROM approval_decisions WHERE id = ?)",
      params: [decisionId],
    };
    const request = await this.get(requestId);
    if (!request) return { kind: "not_found" };
    const [insert] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO approval_decisions
             (id, request_id, user_id, decision, note, surface, decided_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM approval_requests
             WHERE id = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?)
           )`
        )
        .bind(
          decisionId,
          requestId,
          input.userId,
          input.decision,
          input.note,
          input.surface,
          now,
          requestId,
          now
        ),
      this.db
        .prepare(
          `UPDATE approval_requests SET status = ?, decided_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending' AND ${recorded.sql}`
        )
        .bind(status, now, now, requestId, ...recorded.params),
      this.bindAudit(
        actor,
        {
          action: "approval.decided",
          requestId,
          teamId: request.responders.teamId,
          targetUserId: input.userId,
          before: { status: "pending" },
          requested: { decision: input.decision, surface: input.surface },
          after: { status, decision: input.decision, decidedBy: input.userId },
          now,
        },
        recorded
      ),
    ]);

    if (insert!.meta.changes === 1) {
      const decided = await this.get(requestId);
      if (!decided) throw new Error("Approval request vanished after decide");
      return {
        kind: "decided",
        request: decided,
        decision: {
          id: decisionId,
          requestId,
          userId: input.userId,
          decision: input.decision,
          note: input.note,
          surface: input.surface,
          decidedAt: now,
        },
      };
    }

    const current = await this.get(requestId);
    if (!current) return { kind: "not_found" };
    if (current.status === "pending") {
      // Still pending but refused: it is past its expiry, which the sweep has not reached yet.
      return { kind: "conflict", request: (await this.expire(requestId, now)) ?? current };
    }
    const prior = (await this.listDecisions(requestId)).find(
      (decision) => decision.userId === input.userId
    );
    if (prior && prior.decision === input.decision) {
      return { kind: "unchanged", request: current, decision: prior };
    }
    return { kind: "conflict", request: current };
  }

  /** Move pending requests past their expiry to `expired`. Returns how many moved. */
  async expireDue(now: number): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE approval_requests SET status = 'expired', updated_at = ?
         WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`
      )
      .bind(now, now)
      .run();
    return result.meta.changes;
  }

  private async expire(id: string, now: number): Promise<ApprovalRequest | null> {
    await this.db
      .prepare(
        `UPDATE approval_requests SET status = 'expired', updated_at = ?
         WHERE id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`
      )
      .bind(now, id, now)
      .run();
    return this.get(id);
  }

  /** The audit row for a write, inserted only when `predicate` holds in the same batch. */
  private bindAudit(
    actor: ApprovalAuditActor,
    event: {
      action: "approval.requested" | "approval.decided";
      requestId: string;
      teamId: string | null;
      targetUserId?: string;
      before: Record<string, unknown>;
      requested: Record<string, unknown>;
      after: Record<string, unknown>;
      now: number;
    },
    predicate: { sql: string; params: unknown[] }
  ): SqlStatement {
    const actorUserId = actor.kind === "user" ? actor.userId : (actor.actingUserId ?? null);
    return this.db
      .prepare(
        `INSERT INTO authorization_audit_events
           (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot,
            actor_service_snapshot, action, resource_type, resource_id, target_user_id_snapshot,
            team_id, reason_code, operation_result, metadata_json)
         SELECT ?, ?, ?, ?, ?, ?, ?, 'approval_request', ?, ?, ?, ?, 'applied', ?
         WHERE ${predicate.sql}`
      )
      .bind(
        crypto.randomUUID(),
        event.now,
        actor.requestId,
        actor.kind,
        actorUserId,
        actor.kind === "service" ? actor.service : null,
        event.action,
        event.requestId,
        event.targetUserId ?? null,
        event.teamId,
        event.action,
        JSON.stringify({ before: event.before, requested: event.requested, after: event.after }),
        ...predicate.params
      );
  }
}
