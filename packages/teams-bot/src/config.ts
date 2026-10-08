/**
 * The Teams bot's configuration from the process environment.
 *
 * Every variable name is fixed by the deployment contract (the Kubernetes
 * Secret `open-inspect-teams-bot-env` and the Deployment's env block carry
 * exactly these names). An empty variable counts as unset, as `FOO=` in an
 * env file means "no value" rather than "the empty string".
 *
 * Secret values never appear in error messages: a failed parse names the
 * variables that are missing or malformed, nothing else.
 */

import { parseLogLevel, type LogLevel } from "@open-inspect/shared/logger";
import {
  DEFAULT_MODEL,
  getReasoningConfig,
  isValidModel,
  isValidReasoningEffort,
  normalizeModelId,
} from "@open-inspect/shared/models";
import { z } from "zod";
import { parseAllowedServiceUrlHosts } from "./bot-framework/service-url";

/** A source of configuration values, `process.env` in production. */
export type ConfigSource = Record<string, string | undefined>;

export const DEFAULT_ALLOWED_SERVICE_URL_HOSTS = "*.botframework.com,smba.trafficmanager.net";

const nonEmpty = z.string().trim().min(1, "is required");
const absoluteHttpUrl = nonEmpty.refine(
  (value) => /^https?:\/\//i.test(value) && URL.canParse(value),
  "must be an absolute http(s) URL"
);
const guid = nonEmpty.regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  "must be a GUID"
);

const envSchema = z.object({
  TEAMS_BOT_APP_ID: guid,
  TEAMS_BOT_APP_SECRET: nonEmpty,
  TEAMS_BOT_TENANT_ID: guid,
  TEAMS_BOT_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  CONTROL_PLANE_URL: absoluteHttpUrl,
  SERVICE_AUTH_SECRET_TEAMS_BOT: nonEmpty,
  WEB_APP_URL: absoluteHttpUrl,
  TEAMS_BOT_STATE_DIR: nonEmpty.default("/state"),
  TEAMS_BOT_ALLOWED_SERVICE_URL_HOSTS: nonEmpty.default(DEFAULT_ALLOWED_SERVICE_URL_HOSTS),
  HOST: nonEmpty.default("0.0.0.0"),
  LOG_LEVEL: z.string().optional(),
  TEAMS_BOT_DEFAULT_MODEL: z.string().trim().optional(),
  TEAMS_BOT_DEFAULT_REASONING_EFFORT: z.string().trim().optional(),
});

export interface TeamsBotConfig {
  /** Entra application (client) id of the bot registration; also the inbound JWT audience. */
  appId: string;
  appSecret: string;
  /** The single tenant the bot serves; activities from any other tenant are dropped. */
  tenantId: string;
  host: string;
  port: number;
  /** Absolute base URL of the control plane, without a trailing slash. */
  controlPlaneUrl: string;
  /** sig1 signing secret for outbound requests; the control plane signs callbacks with the same key. */
  serviceAuthSecret: string;
  /** Web app origin for session links, without a trailing slash. */
  webAppUrl: string;
  stateDir: string;
  allowedServiceUrlHosts: readonly string[];
  logLevel: LogLevel;
  /**
   * The model a new session starts with when the message carries no `!model`
   * flag: `TEAMS_BOT_DEFAULT_MODEL` in canonical `provider/model` form, or the
   * shared catalog default. The inline flag always wins over it.
   */
  defaultModel: string;
  /** The reasoning effort that goes with `defaultModel`; unset leaves the control plane's default. */
  defaultReasoningEffort: string | undefined;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid Teams bot configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

function withoutEmptyValues(source: ConfigSource): ConfigSource {
  const entries = Object.entries(source).filter(
    ([, value]) => typeof value === "string" && value.trim() !== ""
  );
  return Object.fromEntries(entries);
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function loadConfig(source: ConfigSource): TeamsBotConfig {
  const parsed = envSchema.safeParse(withoutEmptyValues(source));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const name = issue.path.map(String).join(".") || "env";
      const message = issue.code === "invalid_type" ? "is required" : issue.message;
      return `${name} ${message}`;
    });
    throw new ConfigError(problems);
  }
  const env = parsed.data;
  const allowedServiceUrlHosts = parseAllowedServiceUrlHosts(
    env.TEAMS_BOT_ALLOWED_SERVICE_URL_HOSTS
  );
  if (allowedServiceUrlHosts.length === 0) {
    throw new ConfigError(["TEAMS_BOT_ALLOWED_SERVICE_URL_HOSTS must name at least one host"]);
  }
  const { defaultModel, defaultReasoningEffort } = resolveDefaultModel(
    env.TEAMS_BOT_DEFAULT_MODEL,
    env.TEAMS_BOT_DEFAULT_REASONING_EFFORT
  );
  return {
    appId: env.TEAMS_BOT_APP_ID,
    appSecret: env.TEAMS_BOT_APP_SECRET,
    tenantId: env.TEAMS_BOT_TENANT_ID,
    host: env.HOST,
    port: env.TEAMS_BOT_PORT,
    controlPlaneUrl: stripTrailingSlash(env.CONTROL_PLANE_URL),
    serviceAuthSecret: env.SERVICE_AUTH_SECRET_TEAMS_BOT,
    webAppUrl: stripTrailingSlash(env.WEB_APP_URL),
    stateDir: env.TEAMS_BOT_STATE_DIR,
    allowedServiceUrlHosts,
    logLevel: parseLogLevel(env.LOG_LEVEL),
    defaultModel,
    defaultReasoningEffort,
  };
}

/**
 * The deployment's default model and reasoning effort, checked against the
 * shared catalog so a typo fails the boot instead of every session. The
 * message names the value: a model id is configuration, not a secret.
 */
function resolveDefaultModel(
  model: string | undefined,
  reasoningEffort: string | undefined
): { defaultModel: string; defaultReasoningEffort: string | undefined } {
  if (model !== undefined && !isValidModel(model)) {
    throw new ConfigError([`TEAMS_BOT_DEFAULT_MODEL "${model}" is not a known model id`]);
  }
  const defaultModel = model === undefined ? DEFAULT_MODEL : normalizeModelId(model);
  if (reasoningEffort !== undefined && !isValidReasoningEffort(defaultModel, reasoningEffort)) {
    const efforts = getReasoningConfig(defaultModel)?.efforts;
    const detail = efforts?.length
      ? `supported values: ${efforts.join(", ")}`
      : "this model does not support reasoning controls";
    throw new ConfigError([
      `TEAMS_BOT_DEFAULT_REASONING_EFFORT "${reasoningEffort}" is not valid for "${defaultModel}" (${detail})`,
    ]);
  }
  return { defaultModel, defaultReasoningEffort: reasoningEffort };
}
