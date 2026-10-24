/**
 * The GitHub bot's Node configuration from the process environment.
 *
 * The Worker gets the same values as bindings and vars; here they are
 * environment variables with fixed names, and the bindings are replaced by
 * the adapters in runtime.ts. An empty variable counts as unset. Secret
 * values never appear in error messages: a failed parse names the variables
 * that are missing or malformed, nothing else.
 */

import { parseLogLevel, type LogLevel } from "@open-inspect/shared/logger";
import { DEFAULT_MODEL, isValidModel, normalizeModelId } from "@open-inspect/shared/models";
import { z } from "zod";
import { invalidRepoAllowlistEntries, parseRepoAllowlist } from "../repo-allowlist";
import type { Env } from "../types";

/** A source of configuration values, `process.env` in production. */
export type ConfigSource = Record<string, string | undefined>;

const DEFAULT_GITHUB_BOT_PORT = 3200;

const nonEmpty = z.string().trim().min(1, "is required");
// sig1 signs the request path, so the control plane must be served at the
// origin root: a path prefix would change the path the control plane verifies.
const controlPlaneOrigin = nonEmpty.refine((value) => {
  if (!/^https?:\/\//i.test(value) || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.pathname === "/" && url.search === "" && url.hash === "";
}, "must be an absolute http(s) origin with no path");

const envSchema = z.object({
  GITHUB_BOT_PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_GITHUB_BOT_PORT),
  HOST: nonEmpty.default("0.0.0.0"),
  GITHUB_BOT_STATE_DIR: nonEmpty.default("/state"),
  CONTROL_PLANE_URL: controlPlaneOrigin,
  SERVICE_AUTH_SECRET_GITHUB_BOT: nonEmpty,
  GITHUB_WEBHOOK_SECRET: nonEmpty,
  GITHUB_APP_ID: nonEmpty,
  GITHUB_APP_PRIVATE_KEY: nonEmpty,
  GITHUB_APP_INSTALLATION_ID: nonEmpty,
  GITHUB_BOT_USERNAME: nonEmpty,
  SF_GITHUB_REPO_ALLOWLIST: z.string().default(""),
  DEFAULT_MODEL: z.string().trim().optional(),
  DEPLOYMENT_NAME: nonEmpty.default("open-inspect"),
  APP_NAME: z.string().trim().optional(),
  LOG_LEVEL: z.string().optional(),
});

/** The Worker's vars and secrets, as the Node entry supplies them. */
type GitHubBotVars = Omit<Env, "GITHUB_KV" | "AUTOFIX_QUEUE" | "CONTROL_PLANE">;

export interface GitHubBotNodeConfig {
  host: string;
  port: number;
  /** Where the delivery cache file lives; a persistent volume in a cluster. */
  stateDir: string;
  /** The control plane's origin, without a trailing slash. */
  controlPlaneUrl: string;
  logLevel: LogLevel;
  vars: GitHubBotVars;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid GitHub bot configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

function withoutEmptyValues(source: ConfigSource): ConfigSource {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => typeof value === "string" && value.trim() !== "")
  );
}

export function loadConfig(source: ConfigSource): GitHubBotNodeConfig {
  const parsed = envSchema.safeParse(withoutEmptyValues(source));
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const name = issue.path.map(String).join(".") || "env";
        const message = issue.code === "invalid_type" ? "is required" : issue.message;
        return `${name} ${message}`;
      })
    );
  }
  const env = parsed.data;

  // Unset is an empty list: on Node the allowlist always gates, so a
  // deployment acts on no repository until one is named.
  const invalid = invalidRepoAllowlistEntries(parseRepoAllowlist(env.SF_GITHUB_REPO_ALLOWLIST)!);
  if (invalid.length > 0) {
    throw new ConfigError([
      `SF_GITHUB_REPO_ALLOWLIST entries must be owner/name: ${invalid.join(", ")}`,
    ]);
  }
  if (env.DEFAULT_MODEL !== undefined && !isValidModel(env.DEFAULT_MODEL)) {
    throw new ConfigError([`DEFAULT_MODEL "${env.DEFAULT_MODEL}" is not a known model id`]);
  }

  return {
    host: env.HOST,
    port: env.GITHUB_BOT_PORT,
    stateDir: env.GITHUB_BOT_STATE_DIR,
    controlPlaneUrl: new URL(env.CONTROL_PLANE_URL).origin,
    logLevel: parseLogLevel(env.LOG_LEVEL),
    vars: {
      DEPLOYMENT_NAME: env.DEPLOYMENT_NAME,
      ...(env.APP_NAME ? { APP_NAME: env.APP_NAME } : {}),
      DEFAULT_MODEL:
        env.DEFAULT_MODEL === undefined ? DEFAULT_MODEL : normalizeModelId(env.DEFAULT_MODEL),
      GITHUB_BOT_USERNAME: env.GITHUB_BOT_USERNAME,
      GITHUB_APP_ID: env.GITHUB_APP_ID,
      GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
      GITHUB_APP_INSTALLATION_ID: env.GITHUB_APP_INSTALLATION_ID,
      GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET,
      SERVICE_AUTH_SECRET: env.SERVICE_AUTH_SECRET_GITHUB_BOT,
      SF_GITHUB_REPO_ALLOWLIST: env.SF_GITHUB_REPO_ALLOWLIST,
      LOG_LEVEL: env.LOG_LEVEL,
    },
  };
}
