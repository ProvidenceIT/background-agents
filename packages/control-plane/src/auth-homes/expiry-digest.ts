import { computeHmacHex } from "@open-inspect/shared/auth";
import {
  AUTH_HOME_EXPIRY_NOTICE_MS,
  TRIGGER_KINDS,
  type AuthHome,
  type AuthHomeSelection,
  type TriggerKind,
} from "@open-inspect/shared/types/auth-homes";
import { callbackSigningSecret } from "../auth/service/callback-signing";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { FetchClient } from "../platform-ports";
import type { Env } from "../types";
import { authHomeOwnerUserId, UserAuthHomeStore } from "./store";

/**
 * Notices to the owner of each subscription home, sent as a Teams direct
 * message through the Teams bot:
 *
 * - the Claude expiry notice, once per reported expiry, from 14 days before
 *   it (the setup token lasts a year and nothing refreshes it: the owner
 *   mints a new one on their PC);
 * - the weekly digest, once per UTC week after Monday 07:00, of the sessions
 *   the home served the week before, per trigger kind and per person, so an
 *   owner sees who spent their plan, colleagues on a shared home included.
 *
 * Each notice is claimed in `auth_home_notices` before it is posted, so a
 * double tick, a second host or a retry sends it at most once; a failed post
 * gives the claim back and the next tick tries again. A notice carries
 * counts, names and dates: never a token, a volume name or file contents.
 */

const MSTEAMS_DIRECT_MESSAGE_KIND = "msteams.direct_message";

/** The bot's callback route for a direct message (internal URL; the binding routes it). */
const DIRECT_MESSAGE_URL = "https://internal/callbacks/direct_message";
const DELIVERY_TIMEOUT_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** Digests go out from Monday 07:00 UTC, the start of a working day in Europe. */
const DIGEST_SEND_OFFSET_MS = 7 * 60 * 60 * 1000;
/** A claim this old that was neither sent nor released died with its process. */
const STALE_CLAIM_MS = 15 * 60 * 1000;
const OID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type NoticeKind = "claude_expiry" | "weekly_digest";

/** The unsigned body of `POST /callbacks/direct_message` on the Teams bot. */
export interface DirectMessagePayload {
  kind: typeof MSTEAMS_DIRECT_MESSAGE_KIND;
  notificationId: string;
  recipientAadObjectId: string;
  text: string;
  timestamp: number;
}

/** Posts one direct message; resolves true once the bot has accepted it. */
export type DirectMessageSender = (payload: DirectMessagePayload) => Promise<boolean>;

export interface AuthHomeNoticeResult {
  expiryNotices: number;
  digests: number;
}

/** Monday 00:00 UTC of the week containing `nowMs`. */
export function utcWeekStart(nowMs: number): number {
  const day = new Date(nowMs).getUTCDay(); // 0 = Sunday
  const daysSinceMonday = (day + 6) % 7;
  const midnight = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return midnight - daysSinceMonday * DAY_MS;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function notificationId(homeId: string, kind: NoticeKind, periodKey: string): string {
  return `auth-home:${homeId}:${kind}:${periodKey}`;
}

/** The Entra object id of the first of the home's owner ids that has a linked Microsoft identity. */
async function recipientOid(db: SqlDatabase, home: AuthHome): Promise<string | null> {
  const ids = home.ownerUserIds;
  const rows = await db
    .prepare(
      `SELECT user_id, provider_user_id FROM user_identities
       WHERE provider = 'microsoft' AND user_id IN (${ids.map(() => "?").join(", ")})`
    )
    .bind(...ids)
    .all<{ user_id: string; provider_user_id: string }>();
  for (const id of ids) {
    const oid = rows.results.find((row) => row.user_id === id)?.provider_user_id;
    if (oid && OID_PATTERN.test(oid)) return oid;
  }
  return null;
}

async function claimNotice(
  db: SqlDatabase,
  home: AuthHome,
  kind: NoticeKind,
  periodKey: string,
  nowMs: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO auth_home_notices (home_id, kind, period_key, recipient_user_id, claimed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (home_id, kind, period_key) DO UPDATE SET claimed_at = excluded.claimed_at
         WHERE auth_home_notices.sent_at IS NULL
           AND auth_home_notices.claimed_at <= ?`
    )
    .bind(home.id, kind, periodKey, authHomeOwnerUserId(home), nowMs, nowMs - STALE_CLAIM_MS)
    .run();
  return result.meta.changes > 0;
}

async function finishNotice(
  db: SqlDatabase,
  homeId: string,
  kind: NoticeKind,
  periodKey: string,
  sentAt: number
): Promise<void> {
  await db
    .prepare(
      "UPDATE auth_home_notices SET sent_at = ? WHERE home_id = ? AND kind = ? AND period_key = ?"
    )
    .bind(sentAt, homeId, kind, periodKey)
    .run();
}

async function releaseNotice(
  db: SqlDatabase,
  homeId: string,
  kind: NoticeKind,
  periodKey: string
): Promise<void> {
  await db
    .prepare(
      "DELETE FROM auth_home_notices WHERE home_id = ? AND kind = ? AND period_key = ? AND sent_at IS NULL"
    )
    .bind(homeId, kind, periodKey)
    .run();
}

/** The Claude expiry notice for a home, or null when its expiry is unknown or further than 14 days. */
function claudeExpiryNoticeText(home: AuthHome, nowMs: number): string | null {
  const expiresAt = home.claudeExpiresAt;
  if (expiresAt === null || expiresAt - nowMs > AUTH_HOME_EXPIRY_NOTICE_MS) return null;
  const date = isoDate(expiresAt);
  const remaining = expiresAt - nowMs;
  const when =
    remaining <= 0
      ? `expired on ${date}`
      : `expires on ${date} (in ${Math.max(1, Math.round(remaining / DAY_MS))} days)`;
  return [
    `The Claude setup token in your subscription home ${when}.`,
    "Claude sessions on your home are refused once it has expired.",
    "Mint a new token on your PC with `claude setup-token` and copy it into the home with the " +
      "enrolment script; Settings > Subscription homes shows the new expiry once a session has " +
      "mounted the home.",
  ].join(" ");
}

interface DigestRow {
  trigger_kind: string | null;
  trigger_actor_user_id: string | null;
  user_id: string | null;
  work_item_author_user_id: string | null;
  auth_home_selection: string | null;
}

/** One person's sessions on the home in the digest week. */
interface DigestActorLine {
  userId: string;
  name: string;
  selection: AuthHomeSelection;
  total: number;
  byKind: Partial<Record<TriggerKind, number>>;
}

interface WeeklyDigest {
  weekStart: number;
  total: number;
  byKind: Partial<Record<TriggerKind, number>>;
  actors: DigestActorLine[];
  /** Authors of the issues and pull requests a session worked on, when not its actor. */
  workItemAuthors: { userId: string; name: string; total: number }[];
}

async function displayNames(
  db: SqlDatabase,
  userIds: readonly string[]
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (userIds.length === 0) return names;
  const rows = await db
    .prepare(
      `SELECT id, display_name, email FROM users WHERE id IN (${userIds.map(() => "?").join(", ")})`
    )
    .bind(...userIds)
    .all<{ id: string; display_name: string | null; email: string | null }>();
  for (const row of rows.results) names.set(row.id, row.display_name || row.email || row.id);
  return names;
}

function increment<K extends string>(counts: Partial<Record<K, number>>, key: K): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function kindOf(value: string | null): TriggerKind {
  return (TRIGGER_KINDS as readonly string[]).includes(value ?? "")
    ? (value as TriggerKind)
    : "prompt";
}

/** What the home served in the UTC week starting `weekStart`: sessions per kind and per person. */
async function buildWeeklyDigest(
  db: SqlDatabase,
  home: AuthHome,
  weekStart: number
): Promise<WeeklyDigest> {
  const rows = await db
    .prepare(
      `SELECT trigger_kind, trigger_actor_user_id, user_id, work_item_author_user_id,
              auth_home_selection
       FROM sessions
       WHERE auth_home_id = ? AND created_at >= ? AND created_at < ?`
    )
    .bind(home.id, weekStart, weekStart + WEEK_MS)
    .all<DigestRow>();
  const byKind: Partial<Record<TriggerKind, number>> = {};
  const actors = new Map<string, Omit<DigestActorLine, "name">>();
  const authors = new Map<string, number>();
  for (const row of rows.results) {
    const kind = kindOf(row.trigger_kind);
    const actorId = row.trigger_actor_user_id ?? row.user_id ?? "unknown";
    const selection: AuthHomeSelection = row.auth_home_selection === "shared" ? "shared" : "own";
    increment(byKind, kind);
    const key = `${selection}:${actorId}`;
    const line = actors.get(key) ?? { userId: actorId, selection, total: 0, byKind: {} };
    line.total += 1;
    increment(line.byKind, kind);
    actors.set(key, line);
    const author = row.work_item_author_user_id;
    if (author && author !== actorId) authors.set(author, (authors.get(author) ?? 0) + 1);
  }
  const names = await displayNames(db, [
    ...new Set([...[...actors.values()].map((line) => line.userId), ...authors.keys()]),
  ]);
  const nameOf = (userId: string) => names.get(userId) ?? userId;
  return {
    weekStart,
    total: rows.results.length,
    byKind,
    actors: [...actors.values()]
      .map((line) => ({ ...line, name: nameOf(line.userId) }))
      .sort((a, b) =>
        a.selection === b.selection ? b.total - a.total : a.selection === "own" ? -1 : 1
      ),
    workItemAuthors: [...authors.entries()]
      .map(([userId, total]) => ({ userId, name: nameOf(userId), total }))
      .sort((a, b) => b.total - a.total),
  };
}

function kindCounts(counts: Partial<Record<TriggerKind, number>>): string {
  return TRIGGER_KINDS.filter((kind) => counts[kind])
    .map((kind) => `${kind} ${counts[kind]}`)
    .join(", ");
}

/** The digest as the owner reads it in Teams (markdown). */
function weeklyDigestText(digest: WeeklyDigest, ownerUserIds: readonly string[]): string {
  const from = isoDate(digest.weekStart);
  const to = isoDate(digest.weekStart + WEEK_MS - DAY_MS);
  const lines = [
    `**Subscription home, week of ${from} to ${to} (UTC):** ${digest.total} session${digest.total === 1 ? "" : "s"}.`,
    "",
    `By kind: ${kindCounts(digest.byKind)}`,
    "",
    "By person:",
    ...digest.actors.map((line) => {
      const who = ownerUserIds.includes(line.userId) ? `${line.name} (you)` : line.name;
      const how = line.selection === "shared" ? "on your shared home" : "own";
      return `- ${who}, ${how}: ${line.total} (${kindCounts(line.byKind)})`;
    }),
  ];
  if (digest.workItemAuthors.length > 0) {
    lines.push(
      "",
      "Work items by others:",
      ...digest.workItemAuthors.map((author) => `- ${author.name}: ${author.total}`)
    );
  }
  return lines.join("\n");
}

/** Sends through the Teams bot's signed callback route, as the control plane signs callbacks. */
export function teamsDirectMessageSender(
  bot: FetchClient,
  secret: string,
  log: Logger
): DirectMessageSender {
  return async (payload) => {
    const signature = await computeHmacHex(JSON.stringify(payload), secret);
    try {
      const response = await bot.fetch(DIRECT_MESSAGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, signature }),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        log.warn("auth_home.notice_rejected", {
          notification_id: payload.notificationId,
          http_status: response.status,
        });
      }
      return response.ok;
    } catch (error) {
      log.warn("auth_home.notice_failed", {
        notification_id: payload.notificationId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return false;
    }
  };
}

/** Claim, build and post one notice; the claim is given back when the post fails. */
async function deliver(
  db: SqlDatabase,
  send: DirectMessageSender,
  log: Logger,
  home: AuthHome,
  kind: NoticeKind,
  periodKey: string,
  nowMs: number,
  text: () => Promise<string | null>
): Promise<boolean> {
  if (!(await claimNotice(db, home, kind, periodKey, nowMs))) return false;
  const body = await text();
  const oid = body === null ? null : await recipientOid(db, home);
  if (body === null || oid === null) {
    // Nothing to say (an empty week) or nobody to say it to: settled, not retried.
    if (body !== null) {
      log.info("auth_home.notice_no_recipient", { home_id: home.id, notice_kind: kind });
    }
    await finishNotice(db, home.id, kind, periodKey, nowMs);
    return false;
  }
  const delivered = await send({
    kind: MSTEAMS_DIRECT_MESSAGE_KIND,
    notificationId: notificationId(home.id, kind, periodKey),
    recipientAadObjectId: oid,
    text: body,
    timestamp: nowMs,
  });
  if (delivered) await finishNotice(db, home.id, kind, periodKey, nowMs);
  else await releaseNotice(db, home.id, kind, periodKey);
  return delivered;
}

/** One pass over every home: due expiry notices and last week's digests. */
export async function runAuthHomeNotices(
  db: SqlDatabase,
  send: DirectMessageSender,
  log: Logger,
  nowMs: number
): Promise<AuthHomeNoticeResult> {
  const result: AuthHomeNoticeResult = { expiryNotices: 0, digests: 0 };
  const homes = await new UserAuthHomeStore(db).list();
  if (homes.length === 0) return result;
  const thisWeek = utcWeekStart(nowMs);
  // The latest week whose digest is due: last week from Monday 07:00 UTC,
  // the week before until then (sent late if a tick was missed).
  const digestWeek =
    nowMs >= thisWeek + DIGEST_SEND_OFFSET_MS ? thisWeek - WEEK_MS : thisWeek - 2 * WEEK_MS;
  for (const home of homes) {
    const expiryText = claudeExpiryNoticeText(home, nowMs);
    if (expiryText !== null && home.claudeExpiresAt !== null) {
      const sent = await deliver(
        db,
        send,
        log,
        home,
        "claude_expiry",
        String(home.claudeExpiresAt),
        nowMs,
        async () => expiryText
      );
      if (sent) result.expiryNotices += 1;
    }
    if (home.registeredAt < digestWeek + WEEK_MS) {
      const sent = await deliver(
        db,
        send,
        log,
        home,
        "weekly_digest",
        isoDate(digestWeek),
        nowMs,
        async () => {
          const digest = await buildWeeklyDigest(db, home, digestWeek);
          return digest.total === 0 ? null : weeklyDigestText(digest, home.ownerUserIds);
        }
      );
      if (sent) result.digests += 1;
    }
  }
  return result;
}

/**
 * The scheduled entry point: a no-op on a deployment without the Teams bot,
 * since the bot is the only channel a notice can take.
 */
export async function runAuthHomeNoticesJob(
  env: Env,
  db: SqlDatabase,
  log: Logger,
  nowMs: number
): Promise<void> {
  const secret = callbackSigningSecret(env, "teams-bot");
  if (!env.TEAMS_BOT || !secret) return;
  const result = await runAuthHomeNotices(
    db,
    teamsDirectMessageSender(env.TEAMS_BOT, secret, log),
    log,
    nowMs
  );
  if (result.expiryNotices > 0 || result.digests > 0) {
    log.info("auth_home.notices_sent", {
      expiry_notices: result.expiryNotices,
      digests: result.digests,
    });
  }
}
