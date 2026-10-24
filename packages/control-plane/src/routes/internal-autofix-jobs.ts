/**
 * Job ingress for the GitHub bot's Autofix envelopes, for hosts where the bot
 * cannot reach the job queue itself.
 *
 * On Cloudflare the bot sends the envelope to the `github.autofix` Queue
 * directly and the control plane consumes it there. The Node bot has no Queue
 * binding, so it posts the same envelope here, signed as `github-bot`, and the
 * route hands it to `env.JOBS` — the jobs table on Node, the Queue on
 * Cloudflare. The job is durable before the 202 is sent, which is what the
 * bot's `AUTOFIX_QUEUE.send` promises its caller.
 *
 * The job kind is a path parameter because route literals cannot hold a `.`;
 * `github.autofix` is the only kind a bot may enqueue, and any other is 404.
 */

import { githubAutofixEnvelopeSchema } from "@open-inspect/shared";
import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import { error, GITHUB_SERVICE_ROUTE, json, serviceAuthorized } from "./shared";

export const GITHUB_AUTOFIX_JOB_PATH = "/internal/jobs/github.autofix";

async function handleGitHubAutofixJob(
  request: Request,
  env: Env,
  params: { kind: string }
): Promise<Response> {
  if (params.kind !== "github.autofix") return error("Unknown job kind", 404);
  const envelope = await parseBody(request, githubAutofixEnvelopeSchema);
  if (envelope instanceof Response) return envelope;
  await env.JOBS.send({ kind: "github.autofix", payload: envelope });
  return json({ queued: true }, 202);
}

export const internalAutofixJobRoutes = new Hono<ControlPlaneHonoEnv>();

internalAutofixJobRoutes.post(
  "/internal/jobs/:kind",
  admit({ ...GITHUB_SERVICE_ROUTE, authorization: serviceAuthorized("github-bot") }),
  (c) => dispatch(c, handleGitHubAutofixJob)
);
