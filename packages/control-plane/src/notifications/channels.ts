import { teamsDirectMessagePoster } from "../auth-homes/expiry-digest";
import { callbackSigningSecret } from "../auth/service/callback-signing";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { Env } from "../types";
import { NoticeChannelRegistry, type NoticeChannel } from "./registry";
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
    channels.push(
      teamsDirectMessageChannel({
        db,
        post: teamsDirectMessagePoster(env.TEAMS_BOT, teamsSecret),
        log,
        webAppUrl: env.WEB_APP_URL,
      })
    );
  }
  return new NoticeChannelRegistry(channels);
}
