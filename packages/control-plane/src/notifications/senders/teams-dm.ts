import { noticeEnvelopeSchema, renderTeamsNoticeText } from "@open-inspect/shared/notices";
import {
  ENTRA_OBJECT_ID_PATTERN,
  MSTEAMS_DIRECT_MESSAGE_KIND,
  type DirectMessageDelivery,
  type DirectMessagePoster,
} from "../../auth-homes/expiry-digest";
import type { SqlDatabase } from "../../db/sql-database";
import type { Logger } from "../../logger";
import type { NoticeChannel, NoticeDeliveryOutcome } from "../registry";

export const TEAMS_NOTICE_CHANNEL = "teams";

/**
 * Bot statuses that will not change on a retry. 403 is the bot refusing a
 * person who has not installed the Teams app; retrying it would loop, which
 * is what the subscription-home sender's release-and-retry would do here.
 */
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 410, 413, 422]);

/** How the bot's answer settles a notice row. */
export function teamsDeliveryOutcome(delivery: DirectMessageDelivery): NoticeDeliveryOutcome {
  if (delivery.ok) return { kind: "sent" };
  if (delivery.httpStatus === null) return { kind: "retryable", code: "unreachable" };
  const code = `http_${delivery.httpStatus}`;
  return PERMANENT_HTTP_STATUSES.has(delivery.httpStatus)
    ? { kind: "permanent", code }
    : { kind: "retryable", code };
}

export interface TeamsDirectMessageChannelDeps {
  db: SqlDatabase;
  post: DirectMessagePoster;
  log: Logger;
  /** Base URL for the session link; left out without it. */
  webAppUrl?: string;
}

/** The owner's Entra object id, or null when they never signed in with Microsoft. */
export async function ownerObjectId(db: SqlDatabase, userId: string): Promise<string | null> {
  const rows = await db
    .prepare(
      `SELECT provider_user_id FROM user_identities
       WHERE provider = 'microsoft' AND user_id = ?
       ORDER BY created_at, id`
    )
    .bind(userId)
    .all<{ provider_user_id: string }>();
  return (
    rows.results.find((row) => ENTRA_OBJECT_ID_PATTERN.test(row.provider_user_id))
      ?.provider_user_id ?? null
  );
}

/**
 * A Teams direct message to the session's owner, through the same signed bot
 * route as the subscription-home notices. The row's payload is the closed
 * envelope; the text is rendered at send time and never stored.
 */
export function teamsDirectMessageChannel(deps: TeamsDirectMessageChannelDeps): NoticeChannel {
  return {
    id: TEAMS_NOTICE_CHANNEL,

    isEnabled: (settings) => settings.channels.teams,

    async address(session) {
      // Archive and cancel are the owner's own act.
      if (session.envelope === null) return [];
      // The thread the prompt came from already got the bot's reply.
      if (session.repliedInTeamsThread) return [];
      // Motion tells its own users about the work it delegated.
      const fromMotion =
        session.spawnSource === "motion" || session.externalRef?.service === "motion";
      if (fromMotion && session.settings.skipMotionSessions) return [];
      if (session.ownerUserId === null) return [];
      const oid = await ownerObjectId(deps.db, session.ownerUserId);
      if (oid === null) {
        deps.log.info("session_notice.no_microsoft_identity", {
          session_id: session.envelope.sessionId,
        });
        return [];
      }
      return [{ recipientRef: oid, payload: JSON.stringify(session.envelope) }];
    },

    async deliver(notice, nowMs): Promise<NoticeDeliveryOutcome> {
      let envelope;
      try {
        envelope = noticeEnvelopeSchema.parse(JSON.parse(notice.payload));
      } catch {
        return { kind: "permanent", code: "invalid_payload" };
      }
      if (!ENTRA_OBJECT_ID_PATTERN.test(notice.recipientRef)) {
        return { kind: "permanent", code: "invalid_recipient" };
      }
      const delivery = await deps.post({
        kind: MSTEAMS_DIRECT_MESSAGE_KIND,
        // Stable across retries, so the bot posts a redelivered notice once.
        notificationId: `session-notice:${notice.id}`,
        recipientAadObjectId: notice.recipientRef,
        text: renderTeamsNoticeText(envelope, { webAppUrl: deps.webAppUrl }),
        timestamp: nowMs,
      });
      return teamsDeliveryOutcome(delivery);
    },
  };
}
