import type { NoticeEnvelope } from "@open-inspect/shared/notices";
import type { ResolvedNotificationSettings } from "@open-inspect/shared/types/integrations";
import type { SessionStatus, SpawnSource } from "@open-inspect/shared/types/sessions";
import type { ClaimedSessionNotice } from "./notice-store";

/**
 * The channels a session notice can take. The recorder asks each enabled
 * channel whom to tell; the drainer hands each due row back to the channel
 * that addressed it. Adding a channel is registering one more `NoticeChannel`
 * (see `channels.ts`): neither the recorder nor the drainer changes.
 */

/**
 * The statuses a root session can settle into. The owner hears of
 * `completed` and `failed` (archive and cancel are their own act); motion's
 * doorbell rings for all four, since each ends the run it delegated.
 */
export const SETTLED_STATUSES = ["completed", "failed", "cancelled", "archived"] as const;
export type SettledStatus = (typeof SETTLED_STATUSES)[number];

export function isSettledStatus(status: SessionStatus): status is SettledStatus {
  return (SETTLED_STATUSES as readonly SessionStatus[]).includes(status);
}

/** What the session's runtime knows when a root session settles. */
export interface SettledSessionFacts {
  /** The public session id. */
  sessionId: string;
  status: SettledStatus;
  /** When the transition was projected (the session's `updated_at`). */
  occurredAtMs: number;
  /**
   * The owner's closed notice; null for `cancelled` and `archived`, which raise
   * none, and for a settle that did not end a running turn (unarchive).
   */
  envelope: NoticeEnvelope | null;
  /** The status revision this notice belongs to; one notice per revision. */
  revision: number;
  spawnSource: SpawnSource;
  /** The last finished turn came from a Teams, Slack or Linear thread, which its bot answered. */
  repliedInChatThread: boolean;
  /** Users with the session open when it settled; never stored. */
  watchingUserIds: readonly string[];
  /** How long the turn that ended ran; null when unknown. */
  lastTurnDurationMs: number | null;
}

/** The facts plus what the control plane adds from the index and settings. */
export interface SettledSession extends SettledSessionFacts {
  /** The owner's user id from the session index; null for a session with no owner. */
  ownerUserId: string | null;
  /** The owner had the session open when it settled, so saw it end. */
  ownerWatching: boolean;
  /** The ref the creating service attached (`sessions.external_ref*`), or null. */
  externalRef: { service: string; ref: string } | null;
  settings: ResolvedNotificationSettings;
}

/** One recipient on one channel, with the closed message the drainer will send. */
export interface NoticeAddress {
  /** Stable per recipient, so a repeated projection finds the row it already wrote. */
  recipientRef: string;
  /** Serialized closed message; never free text. */
  payload: string;
}

/**
 * `retryable` rows go back to the outbox with a backoff; `permanent` ones are
 * settled as failed. `code` is short and fixed (`http_403`), never a body.
 */
export type NoticeDeliveryOutcome =
  | { kind: "sent" }
  /** `retryAfterMs`: the receiver asked for at least this long before the next attempt. */
  | { kind: "retryable"; code: string; retryAfterMs?: number }
  | { kind: "permanent"; code: string };

export interface NoticeChannel {
  /** Stored in `session_notices.channel`. */
  readonly id: string;
  /** How long a row may wait to go out before it is dropped; defaults to NOTICE_MAX_AGE_MS. */
  readonly maxAgeMs?: number;
  isEnabled(settings: ResolvedNotificationSettings): boolean;
  /** Whom to tell about this session on this channel; empty to stay silent. */
  address(session: SettledSession): Promise<NoticeAddress[]>;
  deliver(notice: ClaimedSessionNotice, nowMs: number): Promise<NoticeDeliveryOutcome>;
}

export class NoticeChannelRegistry {
  private readonly channels = new Map<string, NoticeChannel>();

  constructor(channels: readonly NoticeChannel[]) {
    for (const channel of channels) {
      if (this.channels.has(channel.id)) {
        throw new Error(`Notice channel ${channel.id} is registered twice`);
      }
      this.channels.set(channel.id, channel);
    }
  }

  get(id: string): NoticeChannel | undefined {
    return this.channels.get(id);
  }

  list(): NoticeChannel[] {
    return [...this.channels.values()];
  }
}
