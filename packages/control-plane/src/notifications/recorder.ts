import type { NoticeEnvelope, NoticeReason, NoticeStatus } from "@open-inspect/shared/notices";
import {
  resolveNotificationSettings,
  type ResolvedNotificationSettings,
} from "@open-inspect/shared/types/integrations";
import type { TurnLimit } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxShutdownState } from "@open-inspect/shared/types/sandbox-shutdown";
import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import { IntegrationSettingsStore } from "../db/integration-settings";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { BackgroundTasks } from "../platform-ports";
import type { ArtifactRow, MessageRow, SessionRow } from "../session/types";
import { SessionNoticeStore } from "./notice-store";
import type { NoticeChannelRegistry, SettledSessionFacts } from "./registry";

/**
 * Writes a settled root session's notices into the outbox, one row per
 * enabled channel and recipient. Off unless the `notifications` integration
 * is enabled with a mode other than `off`; in `shadow` the rows are written
 * as `shadow` and the drainer never sends them.
 */

export async function loadNotificationSettings(
  db: SqlDatabase
): Promise<ResolvedNotificationSettings> {
  const stored = await new IntegrationSettingsStore(db).getGlobal("notifications");
  return resolveNotificationSettings(stored?.defaults);
}

/** Notices written; 0 when the feature is off or a repeated projection found its rows. */
export async function recordSessionNotices(
  facts: SettledSessionFacts,
  deps: { db: SqlDatabase; registry: NoticeChannelRegistry; nowMs: number }
): Promise<number> {
  const settings = await loadNotificationSettings(deps.db);
  if (!settings.enabled || settings.mode === "off") return 0;
  const channels = deps.registry.list().filter((channel) => channel.isEnabled(settings));
  if (channels.length === 0) return 0;
  const owner = await deps.db
    .prepare("SELECT user_id FROM sessions WHERE id = ?")
    .bind(facts.envelope.sessionId)
    .first<{ user_id: string | null }>();
  const session = { ...facts, ownerUserId: owner?.user_id ?? null, settings };
  const store = new SessionNoticeStore(deps.db);
  let written = 0;
  for (const channel of channels) {
    for (const address of await channel.address(session)) {
      const inserted = await store.insert(
        {
          sessionId: facts.envelope.sessionId,
          revision: facts.revision,
          status: facts.envelope.status,
          channel: channel.id,
          recipientRef: address.recipientRef,
          reasonCode: facts.envelope.reason,
          payload: address.payload,
          state: settings.mode === "shadow" ? "shadow" : "pending",
        },
        deps.nowMs
      );
      if (inserted) written += 1;
    }
  }
  return written;
}

/** What the session's own storage says when it settles. */
export interface SettlementReading {
  session: Pick<SessionRow, "repo_owner" | "repo_name" | "spawn_source">;
  publicSessionId: string;
  status: NoticeStatus;
  revision: number;
  latestTerminalMessage: Pick<MessageRow, "source" | "callback_context"> | null;
  /** Newest first, as the artifact repository lists them. */
  artifacts: readonly Pick<ArtifactRow, "type" | "url" | "metadata">[];
  activeDurationMs: number;
  lastTurnLimit: TurnLimit | null;
  shutdown: SandboxShutdownState | null;
}

function isHttpsUrl(value: string | null): value is string {
  if (value === null) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** The newest pull request the session opened, when its link is one a notice may carry. */
function latestPullRequest(
  artifacts: SettlementReading["artifacts"]
): Pick<NoticeEnvelope, "prNumber" | "prUrl"> {
  for (const artifact of artifacts) {
    if (artifact.type !== "pr" || !isHttpsUrl(artifact.url)) continue;
    let number: unknown;
    try {
      number = (JSON.parse(artifact.metadata ?? "{}") as { number?: unknown }).number;
    } catch {
      continue;
    }
    if (typeof number === "number" && Number.isInteger(number) && number > 0) {
      return { prNumber: number, prUrl: artifact.url };
    }
  }
  return { prNumber: null, prUrl: null };
}

/**
 * A held sandbox outranks a usage limit: the person has to recover it before
 * waiting for the reset helps.
 */
function noticeReason(reading: SettlementReading): NoticeReason {
  const phase = reading.shutdown?.phase;
  if (phase === "failed" || phase === "unknown") return "recovery_needed";
  if (reading.status === "failed" && reading.lastTurnLimit !== null) return "limit_hit";
  return reading.status;
}

/** The closed facts a notice is built from; nothing else of the session leaves. */
export function settledSessionFacts(reading: SettlementReading): SettledSessionFacts {
  const reason = noticeReason(reading);
  const { repo_owner: owner, repo_name: name } = reading.session;
  const message = reading.latestTerminalMessage;
  return {
    envelope: {
      sessionId: reading.publicSessionId,
      status: reading.status,
      reason,
      repo: owner && name ? `${owner}/${name}` : null,
      ...latestPullRequest(reading.artifacts),
      activeDurationMs: Math.max(0, Math.round(reading.activeDurationMs)),
      resetsAtMs: reason === "limit_hit" ? (reading.lastTurnLimit?.resetsAtMs ?? null) : null,
    },
    revision: reading.revision,
    spawnSource: reading.session.spawn_source,
    repliedInTeamsThread: message?.source === "msteams" && message.callback_context !== null,
  };
}

/** The session's storage, read when it settles. */
export interface SettlementSource {
  latestTerminalMessage(): Pick<MessageRow, "source" | "callback_context"> | null;
  artifacts(): readonly Pick<ArtifactRow, "type" | "url" | "metadata">[];
  activeDurationMs(): number;
  lastTurnLimit(): TurnLimit | null;
  shutdown(): SandboxShutdownState | null;
}

function isNoticeStatus(status: SessionStatus): status is NoticeStatus {
  return status === "completed" || status === "failed";
}

/**
 * The session runtime's end: reads the settlement synchronously, in the same
 * turn as the transition, and writes the outbox rows in the background so a
 * slow or failed D1 write never holds up the status change.
 */
export class SessionNoticeRecorder {
  constructor(
    private readonly deps: {
      backgroundTasks: BackgroundTasks;
      log: Logger;
      source: SettlementSource;
      record: (facts: SettledSessionFacts) => Promise<number>;
    }
  ) {}

  settled(
    session: Pick<SessionRow, "repo_owner" | "repo_name" | "spawn_source" | "parent_session_id">,
    publicSessionId: string,
    status: SessionStatus,
    revision: number
  ): void {
    if (!isNoticeStatus(status)) return;
    // Children report to their parent; only the root session tells a person.
    if (session.parent_session_id) return;
    if (session.spawn_source === "healthcheck") return;
    const { source } = this.deps;
    let facts: SettledSessionFacts;
    try {
      facts = settledSessionFacts({
        session,
        publicSessionId,
        status,
        revision,
        latestTerminalMessage: source.latestTerminalMessage(),
        artifacts: source.artifacts(),
        activeDurationMs: source.activeDurationMs(),
        lastTurnLimit: source.lastTurnLimit(),
        shutdown: source.shutdown(),
      });
    } catch (error) {
      // A notice is best effort; the transition it describes has already happened.
      this.deps.log.error("session_notice.read_failed", { session_id: publicSessionId, error });
      return;
    }
    this.deps.backgroundTasks.submit(
      async () => {
        const written = await this.deps.record(facts);
        if (written > 0) {
          this.deps.log.info("session_notice.recorded", {
            session_id: publicSessionId,
            revision,
            reason: facts.envelope.reason,
            notices: written,
          });
        }
      },
      { name: "session_notice.record", context: { session_id: publicSessionId, revision } }
    );
  }
}
