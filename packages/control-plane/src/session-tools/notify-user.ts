import {
  AGENT_NOTICE_KIND,
  sanitizeAgentNoticeText,
  type AgentNotice,
} from "@open-inspect/shared/notices";
import type { NotifyUserInput } from "@open-inspect/shared/session-tools";
import { hashToken } from "../auth/crypto";
import type { SqlDatabase } from "../db/sql-database";
import { SessionNoticeStore } from "../notifications/notice-store";
import { loadNotificationSettings } from "../notifications/recorder";
import { TEAMS_AGENT_NOTICE_CHANNEL } from "../notifications/senders/teams-agent";
import { ownerObjectId } from "../notifications/senders/teams-dm";

/**
 * `notify_user`: the agent asks for its owner to be told something. The
 * notice goes through the session notice outbox (channel `teams-agent`), so
 * it follows the `notifications` integration's mode like every other notice:
 * nothing while it is off, a text-free row in shadow, a direct message in
 * live. The agent supplies words and an urgency; the recipient is always the
 * session's owner, by direct message, whatever the session's visibility.
 */

/** Notices one session's agent may send in its whole life. */
export const NOTIFY_USER_SESSION_QUOTA = 5;
/** The least time between two notices from one session. */
export const NOTIFY_USER_MIN_INTERVAL_MS = 60 * 1000;
/** `session_notices.status` of an agent notice; it belongs to no status revision. */
export const AGENT_NOTICE_STATUS = "agent";

export interface NotifyUserSession {
  /** The public session id. */
  id: string;
  repoOwner: string | null;
  repoName: string | null;
  userId: string | null;
  parentSessionId: string | null;
}

/** Short and fixed, so a refusal tells the agent what to do without echoing anything. */
export type NotifyUserRefusal =
  | "notifications_off"
  | "child_session"
  | "no_owner"
  | "owner_unreachable"
  | "empty_after_sanitization"
  | "quota_exceeded"
  | "too_soon";

export type NotifyUserOutcome =
  | {
      kind: "accepted";
      /** `queued` sends on the next drain; `recorded` is shadow mode, never sent. */
      delivery: "queued" | "recorded";
      remaining: number;
      audit: { textSha256: string; textLength: number };
    }
  | { kind: "refused"; reason: NotifyUserRefusal; retryAfterMs?: number };

export async function enqueueAgentNotice(
  deps: { db: SqlDatabase; nowMs: number; allowedLinkHosts: readonly string[] },
  session: NotifyUserSession,
  input: NotifyUserInput
): Promise<NotifyUserOutcome> {
  const settings = await loadNotificationSettings(deps.db);
  if (!settings.enabled || settings.mode === "off" || !settings.channels.teams) {
    return { kind: "refused", reason: "notifications_off" };
  }
  // Children report to their parent; only the root session tells a person.
  if (session.parentSessionId) return { kind: "refused", reason: "child_session" };
  if (!session.userId) return { kind: "refused", reason: "no_owner" };

  const text = sanitizeAgentNoticeText(input.message, {
    allowedLinkHosts: deps.allowedLinkHosts,
  });
  if (text.length === 0) return { kind: "refused", reason: "empty_after_sanitization" };

  const prior = await deps.db
    .prepare(
      `SELECT COUNT(*) AS sent, MAX(created_at) AS latest FROM session_notices
       WHERE session_id = ? AND channel = ?`
    )
    .bind(session.id, TEAMS_AGENT_NOTICE_CHANNEL)
    .first<{ sent: number; latest: number | null }>();
  const sent = prior?.sent ?? 0;
  if (sent >= NOTIFY_USER_SESSION_QUOTA) return { kind: "refused", reason: "quota_exceeded" };
  const latest = prior?.latest ?? null;
  if (latest !== null && deps.nowMs - latest < NOTIFY_USER_MIN_INTERVAL_MS) {
    return {
      kind: "refused",
      reason: "too_soon",
      retryAfterMs: NOTIFY_USER_MIN_INTERVAL_MS - (deps.nowMs - latest),
    };
  }

  const oid = await ownerObjectId(deps.db, session.userId);
  if (oid === null) return { kind: "refused", reason: "owner_unreachable" };

  const audit = { textSha256: await hashToken(text), textLength: text.length };
  const shadow = settings.mode === "shadow";
  const notice: AgentNotice = {
    kind: AGENT_NOTICE_KIND,
    sessionId: session.id,
    repo: session.repoOwner && session.repoName ? `${session.repoOwner}/${session.repoName}` : null,
    urgency: input.urgency,
    // Shadow rows are never sent, so they never hold the words.
    ...(shadow ? {} : { text }),
    ...audit,
  };
  // The ordinal is the row's revision: two concurrent calls that read the
  // same count collide on the outbox's unique key, and the second is refused.
  const inserted = await new SessionNoticeStore(deps.db).insert(
    {
      sessionId: session.id,
      revision: sent + 1,
      status: AGENT_NOTICE_STATUS,
      channel: TEAMS_AGENT_NOTICE_CHANNEL,
      recipientRef: oid,
      reasonCode: input.urgency === "high" ? "agent_high" : "agent",
      payload: JSON.stringify(notice),
      state: shadow ? "shadow" : "pending",
    },
    deps.nowMs
  );
  if (!inserted) {
    return { kind: "refused", reason: "too_soon", retryAfterMs: NOTIFY_USER_MIN_INTERVAL_MS };
  }
  return {
    kind: "accepted",
    delivery: shadow ? "recorded" : "queued",
    remaining: NOTIFY_USER_SESSION_QUOTA - sent - 1,
    audit,
  };
}
