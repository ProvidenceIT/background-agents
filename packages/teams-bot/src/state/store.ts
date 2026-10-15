/**
 * The bot's durable state, one SQLite file on the state volume (node:sqlite,
 * no native dependency): each thread's conversations (its main session and
 * colleagues' forks) and their turns' placeholders, the conversation
 * references needed to post proactively after a restart, and the claims that
 * make retried deliveries idempotent (inbound activities by id, callbacks by
 * `(messageId, kind)`, finished once the message is posted).
 *
 * Single writer by construction: the Deployment runs one replica, and
 * node:sqlite's synchronous API serialises every statement within it.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredConversationReference } from "../types";

export const STATE_FILE_NAME = "teams-bot.sqlite";

type TurnState = "idle" | "working";

/**
 * A thread's link to one session. A thread has one main conversation
 * (`forkActor` null), the session a mention started, and at most one fork per
 * person: the session a colleague's follow-up started when they could not
 * spend the main conversation's subscription home. Each conversation has its
 * own turns, "Working..." replies and progress.
 */
export interface ThreadConversation {
  /** Teams conversation id including the root message (`...;messageid=<root>`), or the chat id. */
  threadKey: string;
  sessionId: string;
  /** The person whose fork this is (`microsoft:<oid>`); null for the thread's main conversation. */
  forkActor: string | null;
  /** The Teams user who started the session, as `microsoft:<oid>`; callbacks read the session as this actor. */
  actor: string | null;
  teamId: string | null;
  repoFullName: string | null;
  model: string;
  reasoningEffort: string | null;
  /** Where replies go: the Bot Framework connector the activity named. */
  serviceUrl: string;
  channelId: string | null;
  /** The root post of the thread; replies carry it as `replyToId`. */
  rootActivityId: string | null;
  /** The "Working..." reply the current turn edits in place. */
  progressActivityId: string | null;
  /** The control-plane message id of the prompt in flight, or the last one sent. */
  lastMessageId: string | null;
  turnState: TurnState;
  closed: boolean;
  createdAt: number;
  updatedAt: number;
}

export type NewThreadConversation = Pick<
  ThreadConversation,
  | "threadKey"
  | "sessionId"
  | "forkActor"
  | "actor"
  | "teamId"
  | "repoFullName"
  | "model"
  | "reasoningEffort"
  | "serviceUrl"
  | "channelId"
  | "rootActivityId"
> &
  Partial<Pick<ThreadConversation, "progressActivityId" | "lastMessageId" | "turnState">>;

export type ThreadConversationPatch = Partial<
  Pick<ThreadConversation, "progressActivityId" | "lastMessageId" | "turnState" | "closed">
>;

interface ThreadConversationRow {
  thread_key: string;
  session_id: string;
  fork_actor: string | null;
  actor: string | null;
  team_id: string | null;
  repo_full_name: string | null;
  model: string;
  reasoning_effort: string | null;
  service_url: string;
  channel_id: string | null;
  root_activity_id: string | null;
  progress_activity_id: string | null;
  last_message_id: string | null;
  turn_state: string;
  closed: number;
  created_at: number;
  updated_at: number;
}

const CONVERSATION_COLUMNS = `thread_key, session_id, fork_actor, actor, team_id, repo_full_name, model,
  reasoning_effort, service_url, channel_id, root_activity_id, progress_activity_id, last_message_id,
  turn_state, closed, created_at, updated_at`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_conversations (
  thread_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  fork_actor TEXT,
  actor TEXT,
  team_id TEXT,
  repo_full_name TEXT,
  model TEXT NOT NULL,
  reasoning_effort TEXT,
  service_url TEXT NOT NULL,
  channel_id TEXT,
  root_activity_id TEXT,
  progress_activity_id TEXT,
  last_message_id TEXT,
  turn_state TEXT NOT NULL DEFAULT 'idle' CHECK (turn_state IN ('idle', 'working')),
  closed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (thread_key, session_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_conversations_slot
  ON thread_conversations(thread_key, coalesce(fork_actor, ''));
CREATE TABLE IF NOT EXISTS turn_placeholders (
  thread_key TEXT NOT NULL,
  session_id TEXT,
  message_id TEXT NOT NULL,
  progress_activity_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_key, message_id)
);
CREATE TABLE IF NOT EXISTS conversation_references (
  thread_key TEXT PRIMARY KEY,
  reference_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inbound_activities (
  activity_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS callback_deliveries (
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  posted_at INTEGER,
  PRIMARY KEY (message_id, kind)
);
`;

/**
 * A claim that was taken this long ago and never finished belongs to a
 * delivery that died mid-flight (the process is single-writer and serialises
 * a thread's callbacks, so a live delivery cannot be older than its own
 * reads and posts). Longer than the slowest honest completion: 25 event pages
 * of 20 s each plus the connector round trips.
 */
export const STALE_CALLBACK_CLAIM_MS = 15 * 60 * 1000;

function toConversation(row: ThreadConversationRow): ThreadConversation {
  return {
    threadKey: row.thread_key,
    sessionId: row.session_id,
    forkActor: row.fork_actor,
    actor: row.actor,
    teamId: row.team_id,
    repoFullName: row.repo_full_name,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    serviceUrl: row.service_url,
    channelId: row.channel_id,
    rootActivityId: row.root_activity_id,
    progressActivityId: row.progress_activity_id,
    lastMessageId: row.last_message_id,
    turnState: row.turn_state === "working" ? "working" : "idle",
    closed: row.closed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TeamsStateStore {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number
  ) {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
    this.migrate();
  }

  /** Columns added after the first schema; a database created earlier gains them here. */
  private migrate(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(callback_deliveries)")
      .all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "posted_at")) {
      this.db.exec("ALTER TABLE callback_deliveries ADD COLUMN posted_at INTEGER");
    }
    const placeholderColumns = this.db
      .prepare("PRAGMA table_info(turn_placeholders)")
      .all() as unknown as Array<{ name: string }>;
    if (!placeholderColumns.some((column) => column.name === "session_id")) {
      this.db.exec("ALTER TABLE turn_placeholders ADD COLUMN session_id TEXT");
    }
    this.mergeLegacyThreadTables();
  }

  /**
   * Threads were once kept in two tables, `thread_sessions` (the main
   * conversation) and `thread_forks`; both become rows of
   * `thread_conversations`. A placeholder written before placeholders carried
   * a session belongs to the main conversation.
   */
  private mergeLegacyThreadTables(): void {
    const has = (table: string) =>
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) !== undefined;
    const sessions = has("thread_sessions");
    const forks = has("thread_forks");
    if (!sessions && !forks) return;
    const legacyColumns = `thread_key, session_id, actor, team_id, repo_full_name, model,
      reasoning_effort, service_url, channel_id, root_activity_id, progress_activity_id,
      last_message_id, turn_state, closed, created_at, updated_at`;
    this.db.exec("BEGIN");
    try {
      if (sessions) {
        this.db.exec(
          `INSERT OR IGNORE INTO thread_conversations (fork_actor, ${legacyColumns})
           SELECT NULL, ${legacyColumns} FROM thread_sessions`
        );
        this.db.exec(
          `UPDATE turn_placeholders SET session_id = (
             SELECT session_id FROM thread_sessions
             WHERE thread_sessions.thread_key = turn_placeholders.thread_key
           ) WHERE session_id IS NULL`
        );
        this.db.exec("DROP TABLE thread_sessions");
      }
      if (forks) {
        this.db.exec(
          `INSERT OR IGNORE INTO thread_conversations (fork_actor, ${legacyColumns})
           SELECT actor, ${legacyColumns} FROM thread_forks`
        );
        this.db.exec("DROP TABLE thread_forks");
      }
      this.db.exec("DELETE FROM turn_placeholders WHERE session_id IS NULL");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** The store on disk under `stateDir`, created on first use. */
  static open(stateDir: string, now: () => number = Date.now): TeamsStateStore {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(join(stateDir, STATE_FILE_NAME));
    db.exec("PRAGMA journal_mode = WAL");
    return new TeamsStateStore(db, now);
  }

  /** A throwaway store for tests. */
  static inMemory(now: () => number = Date.now): TeamsStateStore {
    return new TeamsStateStore(new DatabaseSync(":memory:"), now);
  }

  close(): void {
    this.db.close();
  }

  /** The thread's main conversation: the session a mention in it started. */
  getMainConversation(threadKey: string): ThreadConversation | null {
    return this.conversationWhere("thread_key = ? AND fork_actor IS NULL", threadKey);
  }

  /** `actor`'s fork in the thread, open or closed. */
  getFork(threadKey: string, actor: string): ThreadConversation | null {
    return this.conversationWhere("thread_key = ? AND fork_actor = ?", threadKey, actor);
  }

  /** The thread's conversation with `sessionId`: its main one or a fork; callbacks name the session. */
  getConversation(threadKey: string, sessionId: string): ThreadConversation | null {
    return this.conversationWhere("thread_key = ? AND session_id = ?", threadKey, sessionId);
  }

  /**
   * Record a conversation, replacing the one in the same place (the thread's
   * main conversation, or this person's fork) together with its placeholders.
   * The thread's other conversations are untouched.
   */
  putConversation(conversation: NewThreadConversation): ThreadConversation {
    const now = this.now();
    const replaced = conversation.forkActor
      ? this.getFork(conversation.threadKey, conversation.forkActor)
      : this.getMainConversation(conversation.threadKey);
    if (replaced) {
      this.db
        .prepare("DELETE FROM turn_placeholders WHERE thread_key = ? AND session_id = ?")
        .run(replaced.threadKey, replaced.sessionId);
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO thread_conversations (${CONVERSATION_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        conversation.threadKey,
        conversation.sessionId,
        conversation.forkActor,
        conversation.actor,
        conversation.teamId,
        conversation.repoFullName,
        conversation.model,
        conversation.reasoningEffort,
        conversation.serviceUrl,
        conversation.channelId,
        conversation.rootActivityId,
        conversation.progressActivityId ?? null,
        conversation.lastMessageId ?? null,
        conversation.turnState ?? "idle",
        now,
        now
      );
    return this.getConversation(conversation.threadKey, conversation.sessionId)!;
  }

  updateConversation(
    threadKey: string,
    sessionId: string,
    patch: ThreadConversationPatch
  ): ThreadConversation | null {
    const current = this.getConversation(threadKey, sessionId);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE thread_conversations
           SET progress_activity_id = ?, last_message_id = ?, turn_state = ?, closed = ?, updated_at = ?
         WHERE thread_key = ? AND session_id = ?`
      )
      .run(
        next.progressActivityId,
        next.lastMessageId,
        next.turnState,
        next.closed ? 1 : 0,
        this.now(),
        threadKey,
        sessionId
      );
    return this.getConversation(threadKey, sessionId);
  }

  private conversationWhere(where: string, ...params: string[]): ThreadConversation | null {
    const row = this.db
      .prepare(`SELECT * FROM thread_conversations WHERE ${where}`)
      .get(...params) as ThreadConversationRow | undefined;
    return row ? toConversation(row) : null;
  }

  /**
   * Remember which "Working..." reply a turn (control-plane message) owns, so
   * a turn that completes after a follow-up superseded it still finds its own
   * placeholder to write the answer into.
   */
  putTurnPlaceholder(
    threadKey: string,
    sessionId: string,
    messageId: string,
    progressActivityId: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO turn_placeholders (
           thread_key, session_id, message_id, progress_activity_id, created_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_key, message_id) DO UPDATE SET
           session_id = excluded.session_id,
           progress_activity_id = excluded.progress_activity_id`
      )
      .run(threadKey, sessionId, messageId, progressActivityId, this.now());
  }

  getTurnPlaceholder(threadKey: string, messageId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT progress_activity_id FROM turn_placeholders WHERE thread_key = ? AND message_id = ?"
      )
      .get(threadKey, messageId) as { progress_activity_id: string } | undefined;
    return row?.progress_activity_id ?? null;
  }

  deleteTurnPlaceholder(threadKey: string, messageId: string): void {
    this.db
      .prepare("DELETE FROM turn_placeholders WHERE thread_key = ? AND message_id = ?")
      .run(threadKey, messageId);
  }

  getConversationReference(threadKey: string): StoredConversationReference | null {
    const row = this.db
      .prepare("SELECT reference_json FROM conversation_references WHERE thread_key = ?")
      .get(threadKey) as { reference_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.reference_json) as StoredConversationReference;
    } catch {
      return null;
    }
  }

  /**
   * The connector endpoint the tenant's most recent activity named, for a
   * post that answers no activity (a direct message). Null before the bot
   * has heard from anyone.
   */
  latestServiceUrl(): string | null {
    const rows = this.db
      .prepare(
        "SELECT reference_json FROM conversation_references ORDER BY updated_at DESC LIMIT 20"
      )
      .all() as { reference_json: string }[];
    for (const row of rows) {
      try {
        const reference = JSON.parse(row.reference_json) as StoredConversationReference;
        if (typeof reference.serviceUrl === "string" && reference.serviceUrl) {
          return reference.serviceUrl;
        }
      } catch {
        // A malformed row names no endpoint; the next one may.
      }
    }
    return null;
  }

  putConversationReference(threadKey: string, reference: StoredConversationReference): void {
    this.db
      .prepare(
        `INSERT INTO conversation_references (thread_key, reference_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(thread_key) DO UPDATE SET reference_json = excluded.reference_json,
           updated_at = excluded.updated_at`
      )
      .run(threadKey, JSON.stringify(reference), this.now());
  }

  /**
   * Claim an inbound activity id. True the first time, false on a redelivery
   * (Bot Framework retries when the bot does not answer in time).
   */
  claimInboundActivity(activityId: string): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO inbound_activities (activity_id, received_at) VALUES (?, ?)")
      .run(activityId, this.now());
    return result.changes > 0;
  }

  /** Forget inbound claims older than `maxAgeMs`; redeliveries never come that late. */
  pruneInboundActivities(maxAgeMs: number): number {
    const result = this.db
      .prepare("DELETE FROM inbound_activities WHERE received_at < ?")
      .run(this.now() - maxAgeMs);
    return Number(result.changes);
  }

  /**
   * Claim a callback delivery by `(messageId, kind)`. True the first time,
   * and again when an earlier claim was never finished (see
   * {@link markCallbackPosted}) and is older than `staleAfterMs`: that
   * delivery died before it posted, and the retry must be allowed through.
   * False for a finished delivery or one still in flight, so a retried
   * callback renders nothing.
   */
  claimCallback(messageId: string, kind: string, staleAfterMs = STALE_CALLBACK_CLAIM_MS): boolean {
    const now = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO callback_deliveries (message_id, kind, claimed_at, posted_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(message_id, kind) DO UPDATE SET claimed_at = excluded.claimed_at
           WHERE callback_deliveries.posted_at IS NULL
             AND callback_deliveries.claimed_at <= excluded.claimed_at - ?`
      )
      .run(messageId, kind, now, staleAfterMs);
    return result.changes > 0;
  }

  /** The delivery posted its message: the claim is final and no retry may post again. */
  markCallbackPosted(messageId: string, kind: string): void {
    this.db
      .prepare("UPDATE callback_deliveries SET posted_at = ? WHERE message_id = ? AND kind = ?")
      .run(this.now(), messageId, kind);
  }

  /** Give a claim back when rendering failed, so the control plane's retry gets through. */
  releaseCallback(messageId: string, kind: string): void {
    this.db
      .prepare("DELETE FROM callback_deliveries WHERE message_id = ? AND kind = ?")
      .run(messageId, kind);
  }

  /**
   * At startup: nothing is in flight in a fresh process, so every unfinished
   * claim was left by a delivery the previous process did not live to
   * complete. Releasing them lets a redelivery post the message.
   */
  releaseUnpostedCallbacks(): number {
    const result = this.db.prepare("DELETE FROM callback_deliveries WHERE posted_at IS NULL").run();
    return Number(result.changes);
  }
}
