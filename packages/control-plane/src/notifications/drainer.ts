import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { Env } from "../types";
import { createNoticeChannelRegistry } from "./channels";
import { SessionNoticeStore, withoutFreeText } from "./notice-store";
import { loadNotificationSettings } from "./recorder";
import type { NoticeChannelRegistry } from "./registry";

/**
 * Sends the outbox's due notices, from the every-minute scheduler tick. Each
 * row is claimed before it is sent (see notice-store.ts), handed to the
 * channel that addressed it and settled by the channel's outcome. A notice
 * that could not go out within its channel's `maxAgeMs` (else
 * `NOTICE_MAX_AGE_MS`) is dropped: "your session finished" a day late is noise.
 */

/** Rows one tick sends at most; the rest wait a minute. */
export const NOTICE_DRAIN_BATCH = 20;
/** Attempts, the first included, before a retryable failure is given up. */
export const NOTICE_MAX_ATTEMPTS = 5;
export const NOTICE_MAX_AGE_MS = 60 * 60 * 1000;
/** The first retry's delay; each later one doubles it. */
export const NOTICE_RETRY_BASE_MS = 60 * 1000;

export interface NoticeDrainResult {
  sent: number;
  failed: number;
  retried: number;
}

export async function drainSessionNotices(
  store: SessionNoticeStore,
  registry: NoticeChannelRegistry,
  log: Logger,
  nowMs: number
): Promise<NoticeDrainResult> {
  const result: NoticeDrainResult = { sent: 0, failed: 0, retried: 0 };
  for (const notice of await store.claimDue(nowMs, NOTICE_DRAIN_BATCH)) {
    const fields = { notice_id: notice.id, session_id: notice.sessionId, channel: notice.channel };
    // A settled row keeps no agent text, whatever the outcome.
    const settledPayload = withoutFreeText(notice.payload);
    const fail = async (code: string) => {
      await store.markFailed(notice.id, code, nowMs, settledPayload);
      log.warn("session_notice.failed", { ...fields, error_code: code });
      result.failed += 1;
    };
    const channel = registry.get(notice.channel);
    if (nowMs - notice.createdAt > (channel?.maxAgeMs ?? NOTICE_MAX_AGE_MS)) {
      await fail("expired");
      continue;
    }
    if (!channel) {
      await fail("channel_unavailable");
      continue;
    }
    let outcome;
    try {
      outcome = await channel.deliver(notice, nowMs);
    } catch (error) {
      log.warn("session_notice.deliver_threw", { ...fields, error });
      outcome = { kind: "retryable", code: "deliver_threw" } as const;
    }
    if (outcome.kind === "sent") {
      await store.markSent(notice.id, nowMs, settledPayload);
      result.sent += 1;
    } else if (outcome.kind === "permanent" || notice.attempts >= NOTICE_MAX_ATTEMPTS) {
      await fail(outcome.code);
    } else {
      const backoffMs = NOTICE_RETRY_BASE_MS * 2 ** (notice.attempts - 1);
      const delayMs = Math.max(backoffMs, outcome.retryAfterMs ?? 0);
      await store.retryLater(notice.id, outcome.code, nowMs + delayMs, nowMs);
      result.retried += 1;
    }
  }
  return result;
}

/**
 * The scheduled entry point. Sends only in `live` mode; in any other mode
 * pending rows wait, and expire if the mode stays that way.
 */
export async function runSessionNoticesJob(
  env: Env,
  db: SqlDatabase,
  log: Logger,
  nowMs: number
): Promise<void> {
  const settings = await loadNotificationSettings(db);
  if (!settings.enabled || settings.mode !== "live") return;
  const result = await drainSessionNotices(
    new SessionNoticeStore(db),
    createNoticeChannelRegistry(env, db, log),
    log,
    nowMs
  );
  if (result.sent > 0 || result.failed > 0 || result.retried > 0) {
    log.info("session_notice.drained", { ...result });
  }
}
