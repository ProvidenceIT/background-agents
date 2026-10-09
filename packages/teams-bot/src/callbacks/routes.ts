/**
 * `POST /callbacks/{complete,activity,tool_call,thread_closed}`: where the
 * control plane reports on a session this bot started. `POST
 * /callbacks/direct_message` carries a notice for one person instead (the
 * subscription-home expiry notice and weekly digest) and belongs to no
 * session; it is signed the same way. Each route verifies
 * the body signature (see `verify.ts`), checks the shape, then hands over to
 * the completion module inside the thread's queue so a callback and an
 * inbound reply for the same thread never interleave.
 *
 * `complete` and `thread_closed` answer after posting, so a connector failure
 * surfaces as 503 and the control plane's retry can try again; `tool_call`
 * and `activity` acknowledge at once since they carry no obligation.
 */

import { TOKEN_VALIDITY_MS } from "@open-inspect/shared/auth";
import { Hono, type Context } from "hono";
import type { z } from "zod";
import { asError, type Logger } from "../logger";
import {
  deliverCompletion,
  deliverThreadClosed,
  noteToolCall,
  type CompletionDeps,
  type DeliveryOutcome,
} from "../sessions/completion";
import type { KeyedQueue } from "../sessions/handler";
import {
  activityCallbackSchema,
  completeCallbackSchema,
  directMessageCallbackSchema,
  threadClosedCallbackSchema,
  toolCallCallbackSchema,
} from "./schemas";
import { verifySignedCallback, type SignedCallbackPayload } from "./verify";

/** Tool arguments ride along in tool-call callbacks; anything larger is not a callback. */
const MAX_CALLBACK_BODY_BYTES = 1024 * 1024;

/**
 * An activity refresh only claims "still working" for a couple of minutes,
 * so a captured one is worth at most that; the other callbacks get the
 * service-auth window.
 */
const ACTIVITY_CALLBACK_MAX_AGE_MS = 2 * 60 * 1000;

/** The connector endpoint a direct message uses before the bot has heard from anyone. */
export const DEFAULT_DIRECT_MESSAGE_SERVICE_URL = "https://smba.trafficmanager.net/teams/";

const DIRECT_MESSAGE_KIND = "direct_message";

export interface CallbackRouterDeps extends CompletionDeps {
  /** SERVICE_AUTH_SECRET_TEAMS_BOT: the key the control plane signs this bot's callbacks with. */
  secret: string;
  /** The bot registration and tenant a direct message is opened under. */
  appId: string;
  tenantId: string;
  enqueue: KeyedQueue;
  log: Logger;
  now?: () => number;
}

interface RequestTiming {
  traceId: string;
  startedAt: number;
}

type Admission<T> =
  | { ok: true; data: T; payload: SignedCallbackPayload; timing: RequestTiming }
  | { ok: false; respond: Response };

export function createCallbacksRouter(deps: CallbackRouterDeps): Hono {
  const now = deps.now ?? Date.now;
  const router = new Hono();

  function logRequest(
    level: "info" | "warn" | "error",
    fields: Record<string, unknown> & { http_path: string; http_status: number }
  ) {
    deps.log[level]("http.request", { http_method: "POST", ...fields });
  }

  /** Read, verify and shape one callback; `ok: false` means the response is already sent. */
  async function admit<T>(
    c: Context,
    schema: z.ZodType<T>,
    maxAgeMs: number
  ): Promise<Admission<T>> {
    const startedAt = now();
    const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
    const path = new URL(c.req.url).pathname;
    const base = { trace_id: traceId, http_path: path };
    const verification = await verifySignedCallback(await c.req.text(), {
      secret: deps.secret,
      now: startedAt,
      maxAgeMs,
      maxBodyBytes: MAX_CALLBACK_BODY_BYTES,
    });
    if (!verification.ok) {
      logRequest("warn", {
        ...base,
        http_status: verification.status,
        outcome: "rejected",
        reject_reason: verification.reason,
        duration_ms: now() - startedAt,
      });
      const error = verification.status === 401 ? "unauthorized" : "invalid payload";
      return { ok: false, respond: c.json({ error }, verification.status) };
    }
    const parsed = schema.safeParse(verification.payload);
    if (!parsed.success) {
      logRequest("warn", {
        ...base,
        http_status: 400,
        outcome: "rejected",
        reject_reason: "invalid_payload",
        session_id: verification.payload.sessionId,
        duration_ms: now() - startedAt,
      });
      return { ok: false, respond: c.json({ error: "invalid payload" }, 400) };
    }
    return {
      ok: true,
      data: parsed.data,
      payload: verification.payload,
      timing: { traceId, startedAt },
    };
  }

  function finish(
    c: Context,
    timing: RequestTiming,
    outcome: DeliveryOutcome | "accepted",
    fields: Record<string, unknown> = {}
  ): Response {
    logRequest("info", {
      trace_id: timing.traceId,
      http_path: new URL(c.req.url).pathname,
      http_status: 200,
      outcome,
      duration_ms: now() - timing.startedAt,
      ...fields,
    });
    return c.json({ ok: true, outcome });
  }

  function failed(c: Context, timing: RequestTiming, error: unknown): Response {
    logRequest("error", {
      trace_id: timing.traceId,
      http_path: new URL(c.req.url).pathname,
      http_status: 503,
      outcome: "error",
      error: asError(error),
      duration_ms: now() - timing.startedAt,
    });
    return c.json({ error: "delivery failed" }, 503);
  }

  router.post("/complete", async (c) => {
    const admitted = await admit(c, completeCallbackSchema, TOKEN_VALIDITY_MS);
    if (!admitted.ok) return admitted.respond;
    const { data, timing } = admitted;
    try {
      const outcome = await deps.enqueue(data.context.conversationId, () =>
        deliverCompletion(deps, {
          sessionId: data.sessionId,
          messageId: data.messageId,
          success: data.success,
          error: data.error,
          context: data.context,
          traceId: timing.traceId,
        })
      );
      return finish(c, timing, outcome, {
        session_id: data.sessionId,
        message_id: data.messageId,
      });
    } catch (error) {
      return failed(c, timing, error);
    }
  });

  router.post("/thread_closed", async (c) => {
    const admitted = await admit(c, threadClosedCallbackSchema, TOKEN_VALIDITY_MS);
    if (!admitted.ok) return admitted.respond;
    const { data, timing } = admitted;
    try {
      const outcome = await deps.enqueue(data.context.conversationId, () =>
        deliverThreadClosed(deps, {
          sessionId: data.sessionId,
          context: data.context,
          traceId: timing.traceId,
        })
      );
      return finish(c, timing, outcome, { session_id: data.sessionId });
    } catch (error) {
      return failed(c, timing, error);
    }
  });

  router.post("/tool_call", async (c) => {
    const admitted = await admit(c, toolCallCallbackSchema, TOKEN_VALIDITY_MS);
    if (!admitted.ok) return admitted.respond;
    const { data, timing } = admitted;
    const traceId = timing.traceId;
    // Queued behind any completion in flight for the thread, so a late tool
    // call cannot re-assert "Working..." over the final answer.
    void deps
      .enqueue(data.context.conversationId, async () => noteToolCall(deps, data, traceId))
      .catch((error: unknown) => {
        deps.log.error("callback.tool_call", {
          trace_id: traceId,
          session_id: data.sessionId,
          error: asError(error),
        });
      });
    return finish(c, timing, "accepted", {
      session_id: data.sessionId,
      tool: data.tool,
      call_id: data.callId,
    });
  });

  router.post("/activity", async (c) => {
    const admitted = await admit(c, activityCallbackSchema, ACTIVITY_CALLBACK_MAX_AGE_MS);
    if (!admitted.ok) return admitted.respond;
    const { data, timing } = admitted;
    // Teams has no activity indicator to re-assert: the "Working..." reply
    // stays until the completion replaces it. Acknowledged, nothing to render.
    return finish(c, timing, "accepted", {
      session_id: data.sessionId,
      message_id: data.messageId,
    });
  });

  router.post("/direct_message", async (c) => {
    const admitted = await admit(c, directMessageCallbackSchema, TOKEN_VALIDITY_MS);
    if (!admitted.ok) return admitted.respond;
    const { data, timing } = admitted;
    const fields = { notification_id: data.notificationId };
    // One person's notices go out one at a time, and a redelivery of one
    // already posted is acknowledged without a second message.
    try {
      const outcome = await deps.enqueue(`dm:${data.recipientAadObjectId}`, async () => {
        if (!deps.store.claimCallback(data.notificationId, DIRECT_MESSAGE_KIND)) {
          return "duplicate" as const;
        }
        try {
          await deps.bot.sendDirectMessage(
            {
              serviceUrl: deps.store.latestServiceUrl() ?? DEFAULT_DIRECT_MESSAGE_SERVICE_URL,
              botAppId: deps.appId,
              tenantId: deps.tenantId,
              aadObjectId: data.recipientAadObjectId,
            },
            data.text
          );
        } catch (error) {
          deps.store.releaseCallback(data.notificationId, DIRECT_MESSAGE_KIND);
          throw error;
        }
        deps.store.markCallbackPosted(data.notificationId, DIRECT_MESSAGE_KIND);
        return "delivered" as const;
      });
      return finish(c, timing, outcome, fields);
    } catch (error) {
      return failed(c, timing, error);
    }
  });

  return router;
}
