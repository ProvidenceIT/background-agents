import { teamsDirectMessagePoster } from "../auth-homes/expiry-digest";
import { callbackSigningSecret } from "../auth/service/callback-signing";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { Env } from "../types";
import { NoticeChannelRegistry, type NoticeChannel } from "./registry";
import { motionDoorbellChannel, parseMotionCallbackUrl } from "./senders/motion-doorbell";
import { teamsAgentNoticeChannel } from "./senders/teams-agent";
import { teamsDirectMessageChannel } from "./senders/teams-dm";

/**
 * The channels this deployment can use. A channel whose transport is not
 * configured is left out, so the recorder writes no rows for it. The one
 * place a new channel is registered.
 */
export function createNoticeChannelRegistry(
  env: Env,
  db: SqlDatabase,
  log: Logger
): NoticeChannelRegistry {
  const channels: NoticeChannel[] = [];
  const teamsSecret = callbackSigningSecret(env, "teams-bot");
  if (env.TEAMS_BOT && teamsSecret) {
    const post = teamsDirectMessagePoster(env.TEAMS_BOT, teamsSecret);
    channels.push(
      teamsDirectMessageChannel({ db, post, log, webAppUrl: env.WEB_APP_URL }),
      teamsAgentNoticeChannel({ post, webAppUrl: env.WEB_APP_URL })
    );
  }
  // Motion's doorbell needs both its URL and its own secret; either unset is off.
  if (env.MOTION_CALLBACK_URL && env.SERVICE_AUTH_SECRET_MOTION_CALLBACK) {
    let callbackUrl: string | null = null;
    try {
      callbackUrl = parseMotionCallbackUrl(env.MOTION_CALLBACK_URL);
    } catch {
      // The Node host refuses to boot with it; a Worker logs and goes without.
      log.warn("notifications.motion_doorbell_misconfigured", { variable: "MOTION_CALLBACK_URL" });
    }
    if (callbackUrl !== null) {
      channels.push(
        motionDoorbellChannel({
          callbackUrl,
          secret: env.SERVICE_AUTH_SECRET_MOTION_CALLBACK,
          log,
        })
      );
    }
  }
  return new NoticeChannelRegistry(channels);
}
