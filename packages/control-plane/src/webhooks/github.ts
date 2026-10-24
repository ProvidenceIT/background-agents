/**
 * GitHub automation event webhook route — internal endpoint that receives
 * pre-normalized GitHubAutomationEvents from the github-bot, proxies them to
 * the scheduler for automation matching, and piggybacks PR lifecycle
 * tracking (design §5.2) on the same forward. The lifecycle step runs in the
 * background and is additive: its failure never affects automation matching.
 */

import { resolveAppName } from "@open-inspect/shared/app-name";
import type { GitHubAutomationEvent } from "@open-inspect/shared/triggers";
import { listArtifactsResponseSchema } from "@open-inspect/shared/types/artifacts";
import { getGitHubAppConfig } from "../auth/github-app";
import { RepoPathPolicyStore } from "../db/repo-path-policies";
import { SessionIndexStore } from "../db/session-index";
import { SessionPullRequestStore } from "../db/session-pull-request-store";
import { createLogger, parseLogLevel } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { RequestContext } from "../routes/shared";
import { error, GITHUB_SERVICE_ROUTE, serviceAuthorized } from "../routes/shared";
import {
  forwardAutomationEventToScheduler,
  logAutomationEventRejection,
  validateAutomationEventEnvelope,
} from "./automation-event";
import { createProtectedPathGitHub } from "./protected-path-github";
import {
  processProtectedPathHold,
  processPullRequestLifecycleEvent,
  type PullRequestLifecycleDeps,
  type SessionArtifactSummary,
} from "./pull-request-lifecycle";

/**
 * Best-effort PR lifecycle tracking for one normalized event. Runs in
 * waitUntil off the request path; every failure is logged and swallowed.
 */
async function trackPullRequestLifecycle(
  env: Env,
  event: GitHubAutomationEvent,
  ctx: RequestContext
): Promise<void> {
  const log = createLogger(
    "webhook:pr-lifecycle",
    { trace_id: ctx.trace_id, request_id: ctx.request_id },
    parseLogLevel(env.LOG_LEVEL)
  );
  try {
    if (!event.pullRequest) return;

    const sessionRuntime = createSessionRuntimeClient(env, ctx);
    const deps: PullRequestLifecycleDeps = {
      store: new SessionPullRequestStore(ctx.db),
      sessions: new SessionIndexStore(ctx.db),
      listSessionArtifacts: async (sessionId): Promise<SessionArtifactSummary[]> => {
        const response = await sessionRuntime.fetch(sessionId, SessionInternalPaths.artifacts, {
          method: "GET",
        });
        if (!response.ok) {
          throw new Error(`List session artifacts failed (status ${response.status})`);
        }
        let raw: unknown;
        try {
          raw = await response.json();
        } catch {
          throw new Error("List session artifacts returned invalid JSON");
        }
        const parsed = listArtifactsResponseSchema.safeParse(raw);
        if (!parsed.success) throw new Error("List session artifacts returned invalid shape");
        return parsed.data.artifacts ?? [];
      },
      pushSnapshotToSession: async (sessionId, artifactId, snapshot) => {
        const response = await sessionRuntime.fetch(
          sessionId,
          SessionInternalPaths.pullRequestArtifactSnapshot,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(snapshot),
          },
          `?artifactId=${encodeURIComponent(artifactId)}`
        );
        // fetch resolves on 4xx/5xx — a rejected push must fail loudly
        // instead of reading as a mirrored update. The D1 authority has
        // already advanced; read-through repairs the mirror.
        if (!response.ok) {
          throw new Error(`Snapshot push to session DO failed (status ${response.status})`);
        }
      },
      now: () => Date.now(),
    };

    const outcome = await processPullRequestLifecycleEvent(deps, event);
    log.info("pull_request_lifecycle.processed", {
      outcome,
      event_type: event.eventType,
      repo_owner: event.repoOwner,
      repo_name: event.repoName,
      pr_number: event.pullRequest?.number,
    });
  } catch (err) {
    log.error("pull_request_lifecycle.failed", {
      error: err instanceof Error ? err : String(err),
    });
  }

  await checkProtectedPaths(env, event, ctx);
}

/**
 * Protected-path hold for session PRs, after lifecycle tracking has brought
 * the record's head SHA current. A failure leaves the head unchecked, which
 * the merge gate treats as held.
 */
async function checkProtectedPaths(
  env: Env,
  event: GitHubAutomationEvent,
  ctx: RequestContext
): Promise<void> {
  const log = createLogger(
    "webhook:protected-paths",
    { trace_id: ctx.trace_id, request_id: ctx.request_id },
    parseLogLevel(env.LOG_LEVEL)
  );
  const appConfig = getGitHubAppConfig(env);
  if (!appConfig) return;
  try {
    const outcome = await processProtectedPathHold(
      {
        store: new SessionPullRequestStore(ctx.db),
        policies: new RepoPathPolicyStore(ctx.db),
        github: createProtectedPathGitHub(appConfig, {
          cacheStore: env.REPOS_CACHE,
          userAgent: resolveAppName(env),
        }),
      },
      event
    );
    log.info("protected_path_hold.processed", {
      outcome,
      event_type: event.eventType,
      repo_owner: event.repoOwner,
      repo_name: event.repoName,
      pr_number: event.pullRequest?.number,
    });
  } catch (err) {
    log.error("protected_path_hold.failed", {
      error: err instanceof Error ? err : String(err),
      repo_owner: event.repoOwner,
      repo_name: event.repoName,
      pr_number: event.pullRequest?.number,
    });
  }
}

async function handleGitHubAutomationEvent(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logAutomationEventRejection(undefined, "github", ["body"], ctx);
    return error("Invalid JSON", 400);
  }

  const validated = validateAutomationEventEnvelope(body, "github");
  if (validated.response) {
    logAutomationEventRejection(body, "github", validated.issuePaths, ctx);
    return validated.response;
  }

  ctx.executionCtx.submit(() => trackPullRequestLifecycle(env, validated.event, ctx), {
    name: "github_webhook.lifecycle",
  });

  return forwardAutomationEventToScheduler(env, validated.event, ctx);
}

export const githubAutomationEventRoutes = new Hono<ControlPlaneHonoEnv>();

githubAutomationEventRoutes.post(
  "/internal/github-event",
  admit({ ...GITHUB_SERVICE_ROUTE, authorization: serviceAuthorized("github-bot") }),
  (c) => dispatch(c, handleGitHubAutomationEvent)
);
