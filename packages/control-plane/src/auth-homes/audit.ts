import type { AuditOperationAction } from "@open-inspect/shared/types/audit-events";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";

/** The audit vocabulary of subscription auth homes, in `AUDIT_OPERATION_ACTIONS`. */
export type AuthHomeAuditAction = Extract<
  AuditOperationAction,
  | `auth_home.${string}`
  | `credential.${string}`
  | `subscription_sharing.${string}`
  | `provider_account.${string}`
>;

export type AuthHomeAuditResourceType =
  "auth_home" | "subscription_sharing" | "session" | "provider_account";

/**
 * One audit row about a home, a policy flip, or a turn served or refused.
 *
 * `metadata` is stored flat (e.g. `{ from, to }`, `{ home_owner, actor,
 * trigger_kind }`) next to the `before` / `requested` / `after` objects the
 * audit table requires of every operation row; a caller that has no state
 * diff leaves those three as empty objects.
 */
export interface AuthHomeAuditEvent {
  requestId: string;
  /** The acting user; null for a scheduler run, which is written as a service row. */
  actorUserId: string | null;
  action: AuthHomeAuditAction;
  resourceType: AuthHomeAuditResourceType;
  resourceId: string | null;
  /** The person affected: the home owner on a served or refused turn. */
  targetUserId?: string | null;
  /** `applied` for a change or a served turn, `denied` for a refused one. */
  operationResult?: "applied" | "denied";
  before?: Record<string, unknown>;
  requested?: Record<string, unknown>;
  after?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  now?: number;
}

const CONTROL_PLANE_SERVICE = "control-plane";

/** Build the insert for one auth-home audit row, for use alone or inside a batch. */
export function bindAuthHomeAuditEvent(db: SqlDatabase, event: AuthHomeAuditEvent): SqlStatement {
  return db
    .prepare(
      `INSERT INTO authorization_audit_events
        (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot,
         actor_service_snapshot, action, resource_type, resource_id,
         target_user_id_snapshot, reason_code, operation_result, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      event.now ?? Date.now(),
      event.requestId,
      event.actorUserId === null ? "service" : "user",
      event.actorUserId,
      event.actorUserId === null ? CONTROL_PLANE_SERVICE : null,
      event.action,
      event.resourceType,
      event.resourceId,
      event.targetUserId ?? null,
      event.action,
      event.operationResult ?? "applied",
      JSON.stringify({
        before: event.before ?? {},
        requested: event.requested ?? {},
        after: event.after ?? {},
        ...(event.metadata ?? {}),
      })
    );
}
