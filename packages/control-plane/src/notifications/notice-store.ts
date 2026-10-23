import type { SqlDatabase, SqlStatement } from "../db/sql-database";

/**
 * The session notice outbox (`session_notices`, migration 0101).
 *
 * A row is written once per (session, status revision, channel, recipient):
 * a repeated projection of the same revision inserts nothing. The drainer
 * claims due `pending` rows with a compare-and-swap on `claimed_at`, the way
 * the subscription-home notices claim theirs, so a double tick or a second
 * host sends a row at most once; a claim that outlives `STALE_CLAIM_MS` died
 * with its process and is claimed again.
 */

/** A claim this old that was neither settled nor given back died with its process. */
export const STALE_NOTICE_CLAIM_MS = 15 * 60 * 1000;

/** `shadow` rows record what live mode would have sent; nothing ever sends them. */
export type NewNoticeState = "pending" | "shadow";

export interface NewSessionNotice {
  sessionId: string;
  revision: number;
  status: string;
  channel: string;
  recipientRef: string;
  reasonCode: string;
  /** The channel's closed message, serialized; never free text. */
  payload: string;
  state: NewNoticeState;
}

export interface ClaimedSessionNotice {
  id: number;
  sessionId: string;
  revision: number;
  channel: string;
  recipientRef: string;
  payload: string;
  /** Including this claim. */
  attempts: number;
  createdAt: number;
}

interface ClaimedRow {
  id: number;
  session_id: string;
  revision: number;
  channel: string;
  recipient_ref: string;
  payload: string;
  attempts: number;
  created_at: number;
}

/**
 * What a row keeps once it settles: its payload without the agent's words.
 * Only `notify_user` notices carry a `text` field; the audit keeps their hash
 * and length. Any other payload is returned unchanged.
 */
export function withoutFreeText(payload: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return payload;
  if (!("text" in parsed)) return payload;
  const { text: _text, ...rest } = parsed as Record<string, unknown>;
  return JSON.stringify(rest);
}

/** The payload column without a `notify_user` notice's words, in SQL (see withoutFreeText). */
const PAYLOAD_WITHOUT_TEXT_SQL =
  "CASE WHEN json_valid(payload) THEN json_remove(payload, '$.text') ELSE payload END";

/**
 * Settle a deleted session's waiting notices as failed and drop any agent
 * text they hold; batched with the session row's own delete.
 */
export function failPendingNoticesOfSessionStatement(
  db: SqlDatabase,
  sessionId: string,
  nowMs: number
): SqlStatement {
  return db
    .prepare(
      `UPDATE session_notices
       SET state = 'failed', claimed_at = NULL, error_code = 'session_deleted',
         payload = ${PAYLOAD_WITHOUT_TEXT_SQL}, updated_at = ?
       WHERE session_id = ? AND state = 'pending'`
    )
    .bind(nowMs, sessionId);
}

export class SessionNoticeStore {
  constructor(private readonly db: SqlDatabase) {}

  /** Record one notice; false when the same revision already has it. */
  async insert(notice: NewSessionNotice, nowMs: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO session_notices (session_id, revision, status, channel, recipient_ref,
           reason_code, payload, state, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, revision, channel, recipient_ref) DO NOTHING`
      )
      .bind(
        notice.sessionId,
        notice.revision,
        notice.status,
        notice.channel,
        notice.recipientRef,
        notice.reasonCode,
        notice.payload,
        notice.state,
        nowMs,
        nowMs,
        nowMs
      )
      .run();
    return result.meta.changes > 0;
  }

  /** Claim up to `limit` due pending notices, oldest first; each claim counts as an attempt. */
  async claimDue(nowMs: number, limit: number): Promise<ClaimedSessionNotice[]> {
    const staleBefore = nowMs - STALE_NOTICE_CLAIM_MS;
    const candidates = await this.db
      .prepare(
        `SELECT id FROM session_notices
         WHERE state = 'pending' AND next_attempt_at <= ?
           AND (claimed_at IS NULL OR claimed_at <= ?)
         ORDER BY next_attempt_at, id
         LIMIT ?`
      )
      .bind(nowMs, staleBefore, limit)
      .all<{ id: number }>();
    const claimed: ClaimedSessionNotice[] = [];
    for (const { id } of candidates.results) {
      const row = await this.db
        .prepare(
          `UPDATE session_notices
           SET claimed_at = ?, attempts = attempts + 1, updated_at = ?
           WHERE id = ? AND state = 'pending' AND (claimed_at IS NULL OR claimed_at <= ?)
           RETURNING id, session_id, revision, channel, recipient_ref, payload, attempts,
             created_at`
        )
        .bind(nowMs, nowMs, id, staleBefore)
        .first<ClaimedRow>();
      if (row) {
        claimed.push({
          id: row.id,
          sessionId: row.session_id,
          revision: row.revision,
          channel: row.channel,
          recipientRef: row.recipient_ref,
          payload: row.payload,
          attempts: row.attempts,
          createdAt: row.created_at,
        });
      }
    }
    return claimed;
  }

  /** `payload` replaces the stored one (see {@link withoutFreeText}); the row is settled. */
  async markSent(id: number, nowMs: number, payload?: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE session_notices
         SET state = 'sent', delivered_at = ?, claimed_at = NULL, error_code = NULL,
           payload = COALESCE(?, payload), updated_at = ?
         WHERE id = ? AND state = 'pending'`
      )
      .bind(nowMs, payload ?? null, nowMs, id)
      .run();
  }

  /** Settle a notice that will never be sent; `errorCode` is a short code, never a response body. */
  async markFailed(id: number, errorCode: string, nowMs: number, payload?: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE session_notices
         SET state = 'failed', claimed_at = NULL, error_code = ?,
           payload = COALESCE(?, payload), updated_at = ?
         WHERE id = ? AND state = 'pending'`
      )
      .bind(errorCode, payload ?? null, nowMs, id)
      .run();
  }

  /**
   * Settle every waiting notice that no live tick holds as failed, without
   * agent text; for a tick outside live mode, which must not send them later.
   */
  async failPending(errorCode: string, nowMs: number): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE session_notices
         SET state = 'failed', claimed_at = NULL, error_code = ?,
           payload = ${PAYLOAD_WITHOUT_TEXT_SQL}, updated_at = ?
         WHERE state = 'pending' AND (claimed_at IS NULL OR claimed_at <= ?)`
      )
      .bind(errorCode, nowMs, nowMs - STALE_NOTICE_CLAIM_MS)
      .run();
    return result.meta.changes;
  }

  /** Give the claim back and try again from `nextAttemptAtMs`. */
  async retryLater(
    id: number,
    errorCode: string,
    nextAttemptAtMs: number,
    nowMs: number
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE session_notices
         SET claimed_at = NULL, next_attempt_at = ?, error_code = ?, updated_at = ?
         WHERE id = ? AND state = 'pending'`
      )
      .bind(nextAttemptAtMs, errorCode, nowMs, id)
      .run();
  }
}
