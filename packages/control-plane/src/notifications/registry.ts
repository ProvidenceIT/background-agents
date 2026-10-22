import type { NoticeEnvelope } from "@open-inspect/shared/notices";
import type { ResolvedNotificationSettings } from "@open-inspect/shared/types/integrations";
import type { SpawnSource } from "@open-inspect/shared/types/sessions";
import type { ClaimedSessionNotice } from "./notice-store";

/**
 * The channels a session notice can take. The recorder asks each enabled
 * channel whom to tell; the drainer hands each due row back to the channel
 * that addressed it. Adding a channel is registering one more `NoticeChannel`
 * (see `channels.ts`): neither the recorder nor the drainer changes.
 */

/** What the session's runtime knows when a root session settles. */
export interface SettledSessionFacts {
  envelope: NoticeEnvelope;
  /** The status revision this notice belongs to; one notice per revision. */
  revision: number;
  spawnSource: SpawnSource;
  /** The last finished turn came from a Teams thread, which the bot already answered. */
  repliedInTeamsThread: boolean;
}

/** The facts plus what the control plane adds from the index and settings. */
export interface SettledSession extends SettledSessionFacts {
  /** The owner's user id from the session index; null for a session with no owner. */
  ownerUserId: string | null;
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
  { kind: "sent" } | { kind: "retryable"; code: string } | { kind: "permanent"; code: string };

export interface NoticeChannel {
  /** Stored in `session_notices.channel`. */
  readonly id: string;
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
