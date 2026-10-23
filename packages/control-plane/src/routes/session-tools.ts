import { Hono } from "hono";
import {
  motionAddNoteInputSchema,
  notifyUserInputSchema,
  type SessionToolGate,
} from "@open-inspect/shared/session-tools";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { MOTION_EXTERNAL_REF_SERVICE, openSessionToolGates } from "../session-tools/gates";
import {
  createMotionTaskClient,
  delegatedWorkIdFromRef,
  parseMotionApiUrl,
  type MotionFailure,
  type MotionTaskClient,
} from "../session-tools/motion-client";
import { enqueueAgentNotice, type NotifyUserRefusal } from "../session-tools/notify-user";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  type SandboxRouteContext,
} from "./shared";

/**
 * The agent's session tools (`@open-inspect/shared/session-tools`), one route
 * each. Sandbox admission only proves the caller is this session's sandbox;
 * every route then checks its own gate, so a tool the workspace switched off,
 * or one this session was never given, is refused even if the sandbox still
 * has it installed. Refusals carry a fixed sentence for the agent and a code,
 * never a remote response body. Logs carry codes, hashes and lengths, never
 * the agent's words.
 */

const logger = createLogger("session-tools");

function refuse(status: number, reason: string, message: string, retryAfterMs?: number) {
  const body: Record<string, unknown> = { error: message, reason };
  if (retryAfterMs !== undefined) body.retryAfter = Math.ceil(retryAfterMs / 1000);
  return json(body, status);
}

/** The session, when the gate is open for it; otherwise the route's refusal. */
async function admitTool(
  env: Env,
  ctx: SandboxRouteContext,
  sessionId: string,
  gate: SessionToolGate
): Promise<SessionEntry | Response> {
  const session = await new SessionIndexStore(ctx.db).get(sessionId);
  if (!session) return refuse(404, "session_not_found", "Session not found.");
  let open: SessionToolGate[];
  try {
    open = await openSessionToolGates(ctx.db, env, {
      sessionId,
      repoOwner: session.repoOwner,
      repoName: session.repoName,
    });
  } catch (cause) {
    logger.warn("session_tool.gate_resolve_failed", {
      session_id: sessionId,
      gate,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return refuse(503, "unavailable", "This tool is unavailable right now. Do not retry.");
  }
  if (!open.includes(gate)) {
    logger.info("session_tool.denied", { session_id: sessionId, gate, reason: "gate_closed" });
    return refuse(
      403,
      "feature_disabled",
      "This tool is not enabled for this session. Do not retry; carry on without it."
    );
  }
  return session;
}

const NOTIFY_REFUSALS: Record<NotifyUserRefusal, { status: number; message: string }> = {
  notifications_off: {
    status: 503,
    message: "Owner notices are switched off for this deployment. Do not retry.",
  },
  child_session: {
    status: 403,
    message: "Child sessions cannot notify the owner. Report to your parent session instead.",
  },
  no_owner: { status: 409, message: "This session has no owner to notify. Do not retry." },
  owner_unreachable: {
    status: 409,
    message: "The owner cannot be reached by direct message. Do not retry.",
  },
  empty_after_sanitization: {
    status: 422,
    message:
      "The message was empty after mentions, markup and links were removed. Write plain sentences.",
  },
  quota_exceeded: {
    status: 429,
    message: "This session has used all its owner notices. Do not retry.",
  },
  too_soon: { status: 429, message: "Wait at least a minute between notices." },
};

export async function handleNotifyUser(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const session = await admitTool(env, ctx, params.id, "notify");
  if (session instanceof Response) return session;
  const input = await parseBody(request, notifyUserInputSchema);
  if (input instanceof Response) return input;

  const allowedLinkHosts: string[] = [];
  if (env.WEB_APP_URL) {
    try {
      allowedLinkHosts.push(new URL(env.WEB_APP_URL).hostname);
    } catch {
      // A malformed web app URL only means no deployment links survive.
    }
  }
  const outcome = await enqueueAgentNotice(
    { db: ctx.db, nowMs: Date.now(), allowedLinkHosts },
    {
      id: params.id,
      repoOwner: session.repoOwner,
      repoName: session.repoName,
      userId: session.userId ?? null,
      parentSessionId: session.parentSessionId ?? null,
    },
    input
  );
  const fields = {
    session_id: params.id,
    visibility: session.visibility,
    urgency: input.urgency,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  };
  if (outcome.kind === "refused") {
    logger.info("notify_user.refused", { ...fields, reason: outcome.reason });
    const { status, message } = NOTIFY_REFUSALS[outcome.reason];
    return refuse(status, outcome.reason, message, outcome.retryAfterMs);
  }
  logger.info("notify_user.accepted", {
    ...fields,
    delivery: outcome.delivery,
    message_sha256: outcome.audit.textSha256,
    message_length: outcome.audit.textLength,
  });
  return json(
    {
      status: outcome.delivery,
      remaining: outcome.remaining,
      note: "The owner will get a direct message. Do not send the same news again.",
    },
    202
  );
}

const MOTION_REFUSALS: Record<MotionFailure, { status: number; message: string }> = {
  not_linked: {
    status: 404,
    message: "motion has no Task for this session's delegated work. Do not retry.",
  },
  unauthorized: {
    status: 502,
    message: "motion refused this deployment's key. Do not retry; tell the user.",
  },
  rate_limited: { status: 429, message: "motion is rate limiting. Try again in a minute." },
  unavailable: { status: 502, message: "motion is unavailable right now. Try again later." },
};

/** The motion client and the session's delegated work, or the route's refusal. */
async function motionContext(
  env: Env,
  ctx: SandboxRouteContext,
  sessionId: string,
  gate: SessionToolGate,
  clientFor: (env: Env) => MotionTaskClient | null
): Promise<{ client: MotionTaskClient; delegatedWorkId: string } | Response> {
  const session = await admitTool(env, ctx, sessionId, gate);
  if (session instanceof Response) return session;
  const row = await ctx.db
    .prepare("SELECT external_ref_service, external_ref FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ external_ref_service: string | null; external_ref: string | null }>();
  const delegatedWorkId =
    row?.external_ref_service === MOTION_EXTERNAL_REF_SERVICE && row.external_ref
      ? delegatedWorkIdFromRef(row.external_ref)
      : null;
  if (delegatedWorkId === null) {
    return refuse(403, "not_a_motion_session", "This session was not delegated from motion.");
  }
  const client = clientFor(env);
  if (client === null) {
    return refuse(503, "unavailable", "motion is not configured for this deployment.");
  }
  return { client, delegatedWorkId };
}

function motionClientFromEnv(env: Env): MotionTaskClient | null {
  if (!env.MOTION_API_URL || !env.MOTION_API_KEY) return null;
  try {
    return createMotionTaskClient({
      baseUrl: parseMotionApiUrl(env.MOTION_API_URL),
      apiKey: env.MOTION_API_KEY,
    });
  } catch {
    return null;
  }
}

function motionRefusal(sessionId: string, tool: string, reason: MotionFailure): Response {
  logger.warn("motion_tool.failed", { session_id: sessionId, tool, reason });
  const { status, message } = MOTION_REFUSALS[reason];
  return refuse(status, reason, message);
}

/** Factories so tests can hand the routes a fake motion. */
export function createMotionTaskHandlers(clientFor: (env: Env) => MotionTaskClient | null) {
  return {
    async getTask(
      _request: Request,
      env: Env,
      params: { id: string },
      ctx: SandboxRouteContext
    ): Promise<Response> {
      const context = await motionContext(env, ctx, params.id, "motion_read", clientFor);
      if (context instanceof Response) return context;
      const result = await context.client.getTask(context.delegatedWorkId);
      if (!result.ok) return motionRefusal(params.id, "motion_get_task", result.reason);
      return json(result.value);
    },

    async addNote(
      request: Request,
      env: Env,
      params: { id: string },
      ctx: SandboxRouteContext
    ): Promise<Response> {
      const context = await motionContext(env, ctx, params.id, "motion_write", clientFor);
      if (context instanceof Response) return context;
      const input = await parseBody(request, motionAddNoteInputSchema);
      if (input instanceof Response) return input;
      const result = await context.client.addNote(context.delegatedWorkId, input);
      if (!result.ok) return motionRefusal(params.id, "motion_add_note", result.reason);
      logger.info("motion_tool.note_added", {
        session_id: params.id,
        content_length: input.content.length,
      });
      return json({ status: "added", noteId: result.value.noteId }, 201);
    },
  };
}

const motionHandlers = createMotionTaskHandlers(motionClientFromEnv);

export const sessionToolRoutes = new Hono<ControlPlaneHonoEnv>();
const sandbox = admit({
  ...SCM_AGNOSTIC_SANDBOX_ROUTE,
  authorization: NO_AUTHORIZATION,
  cacheControl: "private, no-store",
});
sessionToolRoutes.post("/sessions/:id/notify", sandbox, (c) => dispatch(c, handleNotifyUser));
sessionToolRoutes.get("/sessions/:id/motion/task", sandbox, (c) =>
  dispatch(c, motionHandlers.getTask)
);
sessionToolRoutes.post("/sessions/:id/motion/notes", sandbox, (c) =>
  dispatch(c, motionHandlers.addNote)
);
