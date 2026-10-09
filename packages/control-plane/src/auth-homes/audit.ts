import type { AuditOperationAction } from "@open-inspect/shared/types/audit-events";
import type {
  AuthHomeRefusalReason,
  AuthHomeSelection,
  TriggerKind,
} from "@open-inspect/shared/types/auth-homes";
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
  "auth_home" | "subscription_sharing" | "session" | "provider_account" | "automation";

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

/** What a served or refused turn records about the home and the people involved. */
interface CredentialAuditBase {
  db: SqlDatabase;
  requestId: string;
  /** The trigger actor whose activity the turn is. */
  actorUserId: string | null;
  /**
   * Who performed the write when that is not the trigger actor: null for the
   * scheduler, which records a service row. Defaults to the trigger actor.
   */
  principalUserId?: string | null;
  sessionId: string | null;
  provider: string;
  triggerKind: TriggerKind;
  now?: number;
}

function principalOf(input: CredentialAuditBase): string | null {
  return input.principalUserId === undefined ? input.actorUserId : input.principalUserId;
}

/** `credential.auth_home_mounted`: a new session was bound to a home at create, spawn or run. */
export function bindAuthHomeMountedAudit(
  input: CredentialAuditBase & {
    homeId: string;
    homeOwnerUserId: string;
    selection: AuthHomeSelection;
    workItemAuthorUserId: string | null;
  }
): SqlStatement {
  return bindAuthHomeAuditEvent(input.db, {
    requestId: input.requestId,
    actorUserId: principalOf(input),
    action: "credential.auth_home_mounted",
    resourceType: "session",
    resourceId: input.sessionId,
    targetUserId: input.homeOwnerUserId,
    metadata: {
      session: input.sessionId,
      home_id: input.homeId,
      owner: input.homeOwnerUserId,
      selection: input.selection,
      trigger_kind: input.triggerKind,
      trigger_actor: input.actorUserId,
      work_item_author: input.workItemAuthorUserId,
      provider: input.provider,
    },
    now: input.now,
  });
}

/** `credential.auth_home_prompt`: a turn by `actorUserId` was served from the session's home. */
export function bindAuthHomePromptAudit(
  input: CredentialAuditBase & {
    homeId: string;
    homeOwnerUserId: string;
    selection: AuthHomeSelection;
    /** Which entry point admitted the turn. */
    channel: "prompt" | "ws_token" | "sandbox_access";
  }
): SqlStatement {
  return bindAuthHomeAuditEvent(input.db, {
    requestId: input.requestId,
    actorUserId: input.actorUserId,
    action: "credential.auth_home_prompt",
    resourceType: "session",
    resourceId: input.sessionId,
    targetUserId: input.homeOwnerUserId,
    metadata: {
      home_id: input.homeId,
      home_owner: input.homeOwnerUserId,
      actor: input.actorUserId,
      selection: input.selection,
      trigger_kind: input.triggerKind,
      provider: input.provider,
      channel: input.channel,
    },
    now: input.now,
  });
}

/** `credential.unattended_blocked`: no home may serve a new session; nothing was started. */
export function bindUnattendedBlockedAudit(
  input: CredentialAuditBase & {
    reason: AuthHomeRefusalReason;
    homeId?: string;
    homeOwnerUserId?: string;
    workItemAuthorUserId?: string | null;
    automationId?: string | null;
  }
): SqlStatement {
  return bindAuthHomeAuditEvent(input.db, {
    requestId: input.requestId,
    actorUserId: principalOf(input),
    action: "credential.unattended_blocked",
    resourceType: input.sessionId ? "session" : "auth_home",
    resourceId: input.sessionId ?? input.homeId ?? null,
    targetUserId: input.homeOwnerUserId ?? null,
    operationResult: "denied",
    metadata: {
      reason: input.reason,
      home_id: input.homeId ?? null,
      home_owner: input.homeOwnerUserId ?? null,
      trigger_kind: input.triggerKind,
      trigger_actor: input.actorUserId,
      work_item_author: input.workItemAuthorUserId ?? null,
      automation_id: input.automationId ?? null,
      provider: input.provider,
    },
    now: input.now,
  });
}

/**
 * `auth_home.consent_changed` for an automation: its background consent is
 * the owner's, so an edit by anyone else withdraws it and the owner's own
 * edit gives it again.
 */
export function bindAutomationConsentAudit(
  db: SqlDatabase,
  input: {
    requestId: string;
    actorUserId: string;
    automationId: string;
    ownerUserId: string | null;
    from: number | null;
    to: number | null;
    now?: number;
  }
): SqlStatement {
  return bindAuthHomeAuditEvent(db, {
    requestId: input.requestId,
    actorUserId: input.actorUserId,
    action: "auth_home.consent_changed",
    resourceType: "automation",
    resourceId: input.automationId,
    targetUserId: input.ownerUserId,
    before: { backgroundConsentAt: input.from },
    requested: {},
    after: { backgroundConsentAt: input.to },
    metadata: { by: input.actorUserId, from: input.from, to: input.to, scope: "automation" },
    now: input.now,
  });
}
