import { Hono } from "hono";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { applyIdentityEnforcement } from "../routing/identity-enforcement";
import { SessionInternalPaths, type ContinueAtResetInternalRequest } from "../session/contracts";
import type { Env } from "../types";
import { type SessionRouteContext, dispatchSession } from "./session-route";
import { error, GITHUB_USER_OR_SERVICE_ROUTE, requireSession } from "./shared";

/** Both methods take no body; an empty JSON object carries nothing either. */
async function hasBody(request: Request): Promise<boolean> {
  const text = (await request.text()).trim();
  return text !== "" && text !== "{}";
}

async function handleScheduleContinueAtReset(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  if (await hasBody(request)) return error("This request takes no body", 400);
  const enforcement = applyIdentityEnforcement(ctx, "prompt", {});
  if (enforcement.rejection) return enforcement.rejection;
  const { participantUserId, canonicalUserId } = enforcement.enforced;
  if (!participantUserId || !canonicalUserId || ctx.authorization?.userId !== canonicalUserId) {
    return error("A user identity is required to schedule a continue", 403);
  }
  return ctx.sessionRuntime.fetch(params.id, SessionInternalPaths.continueAtReset, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestedByUserId: canonicalUserId,
      authorId: participantUserId,
    } satisfies ContinueAtResetInternalRequest),
  });
}

async function handleCancelContinueAtReset(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  if (await hasBody(request)) return error("This request takes no body", 400);
  return ctx.sessionRuntime.fetch(params.id, SessionInternalPaths.continueAtReset, {
    method: "DELETE",
  });
}

export const sessionContinueAtResetRoutes = new Hono<ControlPlaneHonoEnv>();

const continueAtResetAdmission = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requireSession("collaborate"),
});

sessionContinueAtResetRoutes.post(
  "/sessions/:id/continue-at-reset",
  continueAtResetAdmission,
  (c) => dispatchSession(c, handleScheduleContinueAtReset)
);

sessionContinueAtResetRoutes.delete(
  "/sessions/:id/continue-at-reset",
  continueAtResetAdmission,
  (c) => dispatchSession(c, handleCancelContinueAtReset)
);
