import { Hono } from "hono";
import { z } from "zod";
import {
  approvalListResponseSchema,
  approvalResponseSchema,
  approvalStatusSchema,
  createApprovalRequestSchema,
  decideApprovalRequestSchema,
  serviceDecideApprovalRequestSchema,
} from "@open-inspect/shared/types/approvals";
import { approvalRegistry } from "../approvals/registry";
import { ApprovalService, type ApprovalDecideResult } from "../approvals/service";
import { AuthorizationError, AuthorizationService } from "../authorization/service";
import { ApprovalRequestStore, type ApprovalAuditActor } from "../db/approval-requests";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import { parseQuery } from "./query";
import {
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  error,
  json,
  requirePermission,
  type RequestContext,
  type RoutePolicy,
  type RouteAuthorization,
} from "./shared";

const logger = createLogger("approvals");

const DECIDE_PERMISSION = "approvals.decide";
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const SCM_AGNOSTIC_SERVICE_ROUTE = {
  authentication: { kind: "service" },
  supportedScmProviders: "all",
} as const satisfies RoutePolicy;

/** The bots that raise approval requests for the factory. */
const CREATE_SERVICES = {
  kind: "service",
  services: ["github-bot", "slack-bot", "linear-bot", "teams-bot"],
  actor: "optional",
  auditAllowed: true,
} as const satisfies RouteAuthorization;

/** The bots that record a person's answer from a card they tapped. */
const DECIDE_SERVICES = {
  kind: "service",
  services: ["teams-bot"],
  actor: "optional",
  auditAllowed: true,
} as const satisfies RouteAuthorization;

const listQuerySchema = z.object({
  status: approvalStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
});

function service(env: Env, ctx: RequestContext): ApprovalService {
  return new ApprovalService(approvalRegistry, ctx.executionCtx, { env, db: ctx.db, log: logger });
}

function userId(ctx: RequestContext): string {
  if (ctx.principal?.kind !== "user") throw new Error("Approval route not admitted");
  return ctx.principal.userId;
}

async function respond(ctx: RequestContext, result: ApprovalDecideResult): Promise<Response> {
  switch (result.kind) {
    case "ok":
      return json(
        approvalResponseSchema.parse({
          request: result.request,
          decisions: await new ApprovalRequestStore(ctx.db).listDecisions(result.request.id),
        })
      );
    case "not_found":
      return error("Approval request not found", 404);
    case "not_a_responder":
      return json({ error: "Not a responder for this request", code: "not_a_responder" }, 403);
    case "invalid_choice":
      return json({ error: "Decision is not one of the choices", code: "invalid_choice" }, 400);
    case "conflict":
      return json(
        {
          error: `Approval request is ${result.request.status}`,
          code: "approval_settled",
          status: result.request.status,
        },
        409
      );
  }
}

async function handleCreate(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  if (ctx.principal?.kind !== "service") throw new Error("Approval route not admitted");
  const body = await parseBody(request, createApprovalRequestSchema);
  if (body instanceof Response) return body;
  const actor: ApprovalAuditActor = {
    requestId: ctx.request_id,
    kind: "service",
    service: ctx.principal.service,
  };
  const result = await service(env, ctx).create(
    { ...body, createdBy: `service:${ctx.principal.service}` },
    actor
  );
  return json(
    approvalResponseSchema.parse({
      request: result.request,
      decisions: result.created
        ? []
        : await new ApprovalRequestStore(ctx.db).listDecisions(result.request.id),
    }),
    result.created ? 201 : 200
  );
}

async function handleList(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const query = parseQuery(request, listQuerySchema);
  if (query instanceof Response) return query;
  const requests = await new ApprovalRequestStore(ctx.db).listForResponder(userId(ctx), {
    status: query.status ?? null,
    limit: query.limit,
  });
  return json(approvalListResponseSchema.parse({ requests }));
}

async function handleGet(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const store = new ApprovalRequestStore(ctx.db);
  const approval = await store.get(params.id);
  // A request is visible to the people who may answer it; others learn nothing about it.
  if (!approval || !(await store.isResponder(approval, userId(ctx)))) {
    return error("Approval request not found", 404);
  }
  return json(
    approvalResponseSchema.parse({
      request: approval,
      decisions: await store.listDecisions(approval.id),
    })
  );
}

async function handleDecide(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const body = await parseBody(request, decideApprovalRequestSchema);
  if (body instanceof Response) return body;
  const actingUserId = userId(ctx);
  const result = await service(env, ctx).decide(
    params.id,
    { userId: actingUserId, decision: body.decision, note: body.note, surface: body.surface },
    { requestId: ctx.request_id, kind: "user", userId: actingUserId }
  );
  return respond(ctx, result);
}

/**
 * A trusted service records the answer of the person who tapped a card. The same rules apply to
 * `actingUserId` as to a signed-in user: active, holding `approvals.decide`, and a responder.
 */
async function handleServiceDecide(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  if (ctx.principal?.kind !== "service") throw new Error("Approval route not admitted");
  const body = await parseBody(request, serviceDecideApprovalRequestSchema);
  if (body instanceof Response) return body;
  try {
    await new AuthorizationService(ctx.db).requirePermission(body.actingUserId, DECIDE_PERMISSION);
  } catch (cause) {
    if (cause instanceof AuthorizationError) {
      return json({ error: "Acting user may not decide approvals", code: cause.code }, 403);
    }
    throw cause;
  }
  const result = await service(env, ctx).decide(
    params.id,
    {
      userId: body.actingUserId,
      decision: body.decision,
      note: body.note,
      surface: body.surface,
    },
    {
      requestId: ctx.request_id,
      kind: "service",
      service: ctx.principal.service,
      actingUserId: body.actingUserId,
    }
  );
  return respond(ctx, result);
}

export const approvalRoutes = new Hono<ControlPlaneHonoEnv>();

const decider = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: requirePermission(DECIDE_PERMISSION, { service: "deny" }),
  cacheControl: "private, no-store",
});

approvalRoutes.post(
  "/approvals",
  admit({ ...SCM_AGNOSTIC_SERVICE_ROUTE, authorization: CREATE_SERVICES }),
  (c) => dispatch(c, handleCreate)
);
approvalRoutes.get("/approvals", decider, (c) => dispatch(c, handleList));
approvalRoutes.get("/approvals/:id", decider, (c) => dispatch(c, handleGet));
approvalRoutes.post("/approvals/:id/decide", decider, (c) => dispatch(c, handleDecide));
approvalRoutes.post(
  "/internal/approvals/:id/decide",
  admit({ ...SCM_AGNOSTIC_SERVICE_ROUTE, authorization: DECIDE_SERVICES }),
  (c) => dispatch(c, handleServiceDecide)
);
