/**
 * The Node bot against the Node control plane: a webhook delivery goes in at
 * the bot's HTTP entry and comes out as a row in the control plane's jobs
 * table (`jobs.db`), through the real sig1 hop and the real job ingress
 * route. The jobs poller is not started, so the row stays where a delivery
 * would claim it from.
 *
 * GitHub sends two deliveries for one review comment:
 * `pull_request_review_comment.created` for the comment and
 * `pull_request_review.submitted` for the review that carries it. Autofix
 * reads the review, so the pair must make exactly one job.
 */

import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../control-plane/src/logger";
import { createNodeBackgroundTasks } from "../../control-plane/src/node/background-tasks";
import { DEFAULT_MIGRATIONS_DIR } from "../../control-plane/src/node/config";
import { NodeJobs } from "../../control-plane/src/node/job-queue";
import {
  JOB_STORE_FILE,
  openJobStore,
  type JobStore,
} from "../../control-plane/src/node/job-store";
import {
  openNodeSqlDatabase,
  type NodeSqlDatabase,
} from "../../control-plane/src/node/sqlite-database";
import { internalAutofixJobRoutes } from "../../control-plane/src/routes/internal-autofix-jobs";
import { GITHUB_SERVICE_ROUTE, serviceAuthorized } from "../../control-plane/src/routes/shared";
import { admit } from "../../control-plane/src/routing/admit";
import { createControlPlaneApp } from "../../control-plane/src/routing/hono-app";
import type { ControlPlaneHonoEnv } from "../../control-plane/src/routing/hono-env";
import type { Env as ControlPlaneEnv } from "../../control-plane/src/types";
import { createGitHubBotNodeRuntime, type GitHubBotNodeRuntime } from "../src/node/runtime";
import {
  nodeConfig,
  reviewCommentPayload,
  reviewSubmittedPayload,
  SERVICE_SECRET,
  webhookRequest,
} from "./node-support";

const KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * The automation-event forward the bot also makes for a review comment. Its
 * real handler needs the scheduler; this test is about the job ingress, so
 * the forward is accepted (still behind github-bot's signature) and dropped.
 */
function acceptedGitHubEventForward(): Hono<ControlPlaneHonoEnv> {
  const routes = new Hono<ControlPlaneHonoEnv>();
  routes.post(
    "/internal/github-event",
    admit({ ...GITHUB_SERVICE_ROUTE, authorization: serviceAuthorized("github-bot") }),
    () => Response.json({ accepted: true }, { status: 202 })
  );
  return routes;
}

describe("GitHub bot on Node -> control plane job store on Node", () => {
  let dataDir: string;
  let stateDir: string;
  let db: NodeSqlDatabase;
  let jobStore: JobStore;
  let server: ServerType;
  let bot: GitHubBotNodeRuntime;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "cp-node-"));
    stateDir = mkdtempSync(join(tmpdir(), "github-bot-node-"));
    db = openNodeSqlDatabase(join(dataDir, "global.db"), {
      migrationsDir: DEFAULT_MIGRATIONS_DIR,
    });
    jobStore = openJobStore(dataDir);
    const log = createLogger("test", {}, "error");
    const env = {
      DEPLOYMENT_NAME: "test",
      GITHUB_BOT_USERNAME: "test-bot[bot]",
      TOKEN_ENCRYPTION_KEY: KEY,
      PROVIDER_ACCOUNTS_ENCRYPTION_KEY: KEY,
      REPO_SECRETS_ENCRYPTION_KEY: KEY,
      SERVICE_AUTH_SECRET_GITHUB_BOT: SERVICE_SECRET,
      LOG_LEVEL: "error",
      DB: db,
      JOBS: new NodeJobs({ store: jobStore, deps: () => ({ env, db, log }), log }),
    } as unknown as ControlPlaneEnv;
    const tasks = createNodeBackgroundTasks(log);
    const app = createControlPlaneApp([internalAutofixJobRoutes, acceptedGitHubEventForward()], {
      backgroundTasks: () => tasks,
    });
    server = serve({ fetch: (request) => app.fetch(request, env), port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;

    bot = createGitHubBotNodeRuntime(nodeConfig(stateDir, {}, `http://127.0.0.1:${port}`));
  });

  afterEach(async () => {
    await bot.tasks.drain(5_000);
    bot.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    jobStore.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** Every row in the control plane's jobs table, read from the file. */
  function jobRows(): Array<{ kind: string; status: string; payload: unknown }> {
    const file = new DatabaseSync(join(dataDir, JOB_STORE_FILE), { readOnly: true });
    try {
      return (
        file.prepare("SELECT kind, status, payload FROM jobs").all() as Array<{
          kind: string;
          status: string;
          payload: string;
        }>
      ).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
    } finally {
      file.close();
    }
  }

  it("turns a review comment's deliveries into exactly one github.autofix job", async () => {
    const comment = await bot.fetch(
      await webhookRequest(
        "pull_request_review_comment",
        "delivery-comment",
        reviewCommentPayload()
      )
    );
    const review = await bot.fetch(
      await webhookRequest("pull_request_review", "delivery-review", reviewSubmittedPayload())
    );
    // GitHub redelivers on a slow acknowledgement; the replay must not add a job.
    const replay = await bot.fetch(
      await webhookRequest("pull_request_review", "delivery-review", reviewSubmittedPayload())
    );
    expect(await bot.tasks.drain(5_000)).toBe(0);

    expect([comment.status, review.status, replay.status]).toEqual([200, 200, 200]);
    expect(await replay.json()).toEqual({ ok: true, duplicate: true });
    expect(jobRows()).toEqual([
      {
        kind: "github.autofix",
        status: "pending",
        payload: {
          version: 1,
          eventType: "pull_request_review",
          action: "submitted",
          deliveryId: "delivery-review",
          providerObject: { kind: "review", id: "5678" },
          repository: { id: "99", owner: "acme", name: "widgets" },
          pullRequestNumber: 42,
          receivedAt: expect.any(String),
        },
      },
    ]);
  });

  it("writes no job for a repository outside the allowlist", async () => {
    const otherRepo = { id: 100, name: "other", private: true, owner: { login: "acme" } };

    const response = await bot.fetch(
      await webhookRequest(
        "pull_request_review",
        "delivery-other",
        reviewSubmittedPayload(otherRepo)
      )
    );
    await bot.tasks.drain(5_000);

    expect(await response.json()).toEqual({ ok: true, ignored: "repo_not_allowlisted" });
    expect(jobRows()).toEqual([]);
  });
});
