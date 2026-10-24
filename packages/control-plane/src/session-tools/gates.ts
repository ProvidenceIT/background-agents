import type { SessionToolGate } from "@open-inspect/shared/session-tools";
import { resolveSessionToolGates } from "@open-inspect/shared/types/integrations";
import { callbackSigningSecret } from "../auth/service/callback-signing";
import { IntegrationSettingsStore } from "../db/integration-settings";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";

/**
 * Which session tools a session may use. A gate is open when the
 * `session-tools` integration lists it for the session's repository and this
 * deployment can serve it: `notify` needs the Teams bot (the owner's DM),
 * `motion_*` need motion's REST API configured and a session motion started,
 * and `repo_context` needs nothing more (it reads only the control plane's
 * own repository ownership records).
 * The launch path resolves the set once to decide which tools to install;
 * each route asks again on every call, since sandbox admission grants
 * nothing specific and settings can change while the sandbox runs.
 */

export const MOTION_EXTERNAL_REF_SERVICE = "motion";

export type SessionToolsEnv = Pick<
  Env,
  "TEAMS_BOT" | "SERVICE_AUTH_SECRET_TEAMS_BOT" | "MOTION_API_URL" | "MOTION_API_KEY"
>;

export interface SessionToolTarget {
  /** The public session id (`sessions.id` in the index). */
  sessionId: string;
  repoOwner: string | null;
  repoName: string | null;
}

export function teamsDirectMessagesAvailable(env: SessionToolsEnv): boolean {
  return Boolean(env.TEAMS_BOT && callbackSigningSecret(env, "teams-bot"));
}

export function motionApiAvailable(env: SessionToolsEnv): boolean {
  return Boolean(env.MOTION_API_URL && env.MOTION_API_KEY);
}

async function startedByMotion(db: SqlDatabase, sessionId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT external_ref_service, external_ref FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ external_ref_service: string | null; external_ref: string | null }>();
  return row?.external_ref_service === MOTION_EXTERNAL_REF_SERVICE && Boolean(row.external_ref);
}

/** The gates the settings list for this session, before asking what the deployment can serve. */
export async function configuredSessionToolGates(
  db: SqlDatabase,
  target: Pick<SessionToolTarget, "repoOwner" | "repoName">
): Promise<SessionToolGate[]> {
  const store = new IntegrationSettingsStore(db);
  const repo =
    target.repoOwner && target.repoName ? `${target.repoOwner}/${target.repoName}` : null;
  if (repo === null) {
    // An allowlist scopes repositories, so a session without one follows the
    // defaults; but an empty allowlist is the integration switched off.
    const global = await store.getGlobal("session-tools");
    if (Array.isArray(global?.enabledRepos) && global.enabledRepos.length === 0) return [];
    return resolveSessionToolGates({ enabledRepos: null, settings: global?.defaults }, null);
  }
  return resolveSessionToolGates(await store.getResolvedConfig("session-tools", repo), repo);
}

/** The gates open for this session now; empty by default. */
export async function openSessionToolGates(
  db: SqlDatabase,
  env: SessionToolsEnv,
  target: SessionToolTarget
): Promise<SessionToolGate[]> {
  const configured = await configuredSessionToolGates(db, target);
  if (configured.length === 0) return [];
  const motion =
    configured.some((gate) => gate === "motion_read" || gate === "motion_write") &&
    motionApiAvailable(env) &&
    (await startedByMotion(db, target.sessionId));
  return configured.filter((gate) => {
    if (gate === "notify") return teamsDirectMessagesAvailable(env);
    if (gate === "repo_context") return true;
    return motion;
  });
}
