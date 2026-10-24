/**
 * Process entry: configuration from the environment, the runtime opened, the
 * server started, and SIGTERM turned into an orderly shutdown that lets the
 * webhook work already acknowledged finish first.
 */

import { serve } from "@hono/node-server";
import { createLogger } from "../logger";
import { loadConfig } from "./config";
import { CACHE_SWEEP_INTERVAL_MS, createGitHubBotNodeRuntime } from "./runtime";

/** How long a shutdown waits for in-flight webhook work; inside Kubernetes' default 30 s grace. */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 25_000;

function main(): void {
  const config = loadConfig(process.env);
  const log = createLogger("main", {}, config.logLevel);
  const runtime = createGitHubBotNodeRuntime(config);

  const sweep = (): void => {
    runtime.sweepCache().catch((error: unknown) => {
      log.warn("github_bot.cache_sweep_failed", {
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
  };
  sweep();
  const sweeper = setInterval(sweep, CACHE_SWEEP_INTERVAL_MS);
  sweeper.unref();

  const server = serve(
    { fetch: (request) => runtime.fetch(request), port: config.port, hostname: config.host },
    (info) => log.info("github_bot.listening", { host: info.address, port: info.port })
  );

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    log.info("github_bot.signal", { signal });
    clearInterval(sweeper);
    server.close();
    void runtime.tasks.drain(SHUTDOWN_DRAIN_TIMEOUT_MS).then((abandoned) => {
      if (abandoned > 0) log.warn("github_bot.shutdown_abandoned_tasks", { count: abandoned });
      runtime.close();
      process.exit(abandoned > 0 ? 1 : 0);
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main();
