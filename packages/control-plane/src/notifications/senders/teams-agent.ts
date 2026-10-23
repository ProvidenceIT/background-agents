import { agentNoticeSchema, renderTeamsAgentNoticeText } from "@open-inspect/shared/notices";
import {
  ENTRA_OBJECT_ID_PATTERN,
  MSTEAMS_DIRECT_MESSAGE_KIND,
  type DirectMessagePoster,
} from "../../auth-homes/expiry-digest";
import type { NoticeChannel, NoticeDeliveryOutcome } from "../registry";
import { teamsDeliveryOutcome } from "./teams-dm";

/**
 * The channel `notify_user` notices take: a Teams direct message to the
 * session's owner, through the same signed bot route as the settle notices.
 * A settling session raises none of these (`address` is always empty); the
 * `notify_user` route writes them (session-tools/notify-user.ts). The row
 * carries the cleaned text only until it settles; the drainer then drops it.
 */
export const TEAMS_AGENT_NOTICE_CHANNEL = "teams-agent";

export function teamsAgentNoticeChannel(deps: {
  post: DirectMessagePoster;
  /** Base URL for the session link; left out without it. */
  webAppUrl?: string;
}): NoticeChannel {
  return {
    id: TEAMS_AGENT_NOTICE_CHANNEL,

    isEnabled: (settings) => settings.channels.teams,

    address: async () => [],

    async deliver(notice, nowMs): Promise<NoticeDeliveryOutcome> {
      let parsed;
      try {
        parsed = agentNoticeSchema.parse(JSON.parse(notice.payload));
      } catch {
        return { kind: "permanent", code: "invalid_payload" };
      }
      const { text } = parsed;
      if (text === undefined) return { kind: "permanent", code: "no_text" };
      if (!ENTRA_OBJECT_ID_PATTERN.test(notice.recipientRef)) {
        return { kind: "permanent", code: "invalid_recipient" };
      }
      const delivery = await deps.post({
        kind: MSTEAMS_DIRECT_MESSAGE_KIND,
        notificationId: `session-notice:${notice.id}`,
        recipientAadObjectId: notice.recipientRef,
        text: renderTeamsAgentNoticeText({ ...parsed, text }, { webAppUrl: deps.webAppUrl }),
        timestamp: nowMs,
      });
      return teamsDeliveryOutcome(delivery);
    },
  };
}
