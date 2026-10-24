/**
 * The GitHub bot's Hono app with Node adapters in place of the Worker's
 * bindings. main.ts serves it; tests drive `fetch` directly.
 */

import type { ExecutionContext } from "hono";
import app from "../index";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { BackgroundTasks } from "./background-tasks";
import { openNodeCacheDatabase } from "./cache-database";
import type { GitHubBotNodeConfig } from "./config";
import { createControlPlaneAutofixQueue, createControlPlaneFetcher } from "./control-plane";

/** How often expired delivery entries are removed from the cache file. */
export const CACHE_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

export interface GitHubBotNodeRuntime {
  fetch(request: Request): Promise<Response>;
  /** The work `waitUntil` handed off, for shutdown to drain. */
  tasks: BackgroundTasks;
  /** Remove expired cache entries. */
  sweepCache(): Promise<void>;
  /** Close the cache file. Call after `tasks` has drained. */
  close(): void;
}

export interface GitHubBotNodeRuntimeOptions {
  /** Outbound HTTP to the control plane; global `fetch` unless a test supplies one. */
  fetchFn?: typeof fetch;
}

export function createGitHubBotNodeRuntime(
  config: GitHubBotNodeConfig,
  options: GitHubBotNodeRuntimeOptions = {}
): GitHubBotNodeRuntime {
  const cache = openNodeCacheDatabase(config.stateDir);
  const controlPlane = createControlPlaneFetcher(config.controlPlaneUrl, options.fetchFn);
  const env: Env = {
    ...config.vars,
    GITHUB_KV: cache.store,
    CONTROL_PLANE: controlPlane,
    AUTOFIX_QUEUE: createControlPlaneAutofixQueue({
      CONTROL_PLANE: controlPlane,
      SERVICE_AUTH_SECRET: config.vars.SERVICE_AUTH_SECRET,
    }),
  };
  const tasks = new BackgroundTasks(createLogger("background", {}, config.logLevel));
  const executionCtx: ExecutionContext = {
    waitUntil: (promise) => tasks.track(promise),
    passThroughOnException: () => {},
    props: {},
  };

  return {
    fetch: (request) => Promise.resolve(app.fetch(request, env, executionCtx)),
    tasks,
    sweepCache: () => cache.store.deleteExpired(),
    close: () => cache.close(),
  };
}
