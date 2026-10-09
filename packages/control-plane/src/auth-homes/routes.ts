import { Hono } from "hono";
import {
  authHomeMetadataSchema,
  authHomeResponseSchema,
  authHomesResponseSchema,
  putAuthHomeRequestSchema,
  putSubscriptionSharingRequestSchema,
  subscriptionSharingSchema,
  type AuthHome,
  type PutAuthHomeRequest,
} from "@open-inspect/shared/types/auth-homes";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "../routes/body";
import {
  error,
  json,
  requirePermission,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type UserRouteContext,
} from "../routes/shared";
import { bindAuthHomeAuditEvent } from "./audit";
import { AuthHomeValidationError, SubscriptionSharingStore, UserAuthHomeStore } from "./store";

/**
 * Subscription auth-home routes.
 *
 * `/me/auth-home` is the caller's own registration and nothing else: the
 * owner is the admitted user, the body never names one, and no route reads
 * another person's home by id. `/auth-homes` lists metadata (no volume
 * names) for the roles that administer the workspace. `/subscription-sharing`
 * is the one workspace-wide switch.
 */

const PRIVATE_NO_STORE = "private, no-store" as const;
const NO_HOME = "No subscription home is registered for you";

function consentAt(current: number | null, consented: boolean, now: number): number | null {
  if (!consented) return null;
  return current ?? now;
}

async function getOwnHome(_request: Request, _env: Env, _params: object, ctx: UserRouteContext) {
  const home = await new UserAuthHomeStore(ctx.db).findOwnedBy(ctx.principal.userId);
  return home ? json(authHomeResponseSchema.parse({ home })) : error(NO_HOME, 404);
}

/** Register the caller's home, or replace every mutable field of the one they have. */
async function putOwnHome(request: Request, _env: Env, _params: object, ctx: UserRouteContext) {
  const body = await parseBody(request, putAuthHomeRequestSchema, undefined);
  if (body instanceof Response) return body;
  const store = new UserAuthHomeStore(ctx.db);
  const actorUserId = ctx.principal.userId;
  const now = Date.now();
  const current = await store.findOwnedBy(actorUserId);
  try {
    const home = current
      ? await replaceHome(store, current, body, now)
      : await store.register({
          ownerUserIds: [actorUserId],
          pvcName: body.pvcName,
          nodeName: body.nodeName,
          providers: body.providers,
          kindsEnabled: body.kindsEnabled,
          backgroundConsentAt: consentAt(null, body.backgroundConsent, now),
          maxConcurrent: body.maxConcurrent,
          shared: body.shared,
          sharingConsentAt: consentAt(null, body.shared, now),
          status: body.status,
          now,
        });
    if (!home) return error(NO_HOME, 404);
    await ctx.db.batch(auditHomeChange(ctx, current, home));
    return json(authHomeResponseSchema.parse({ home }));
  } catch (cause) {
    if (cause instanceof AuthHomeValidationError) return error(cause.message, 400);
    if (cause instanceof Error && /UNIQUE constraint/i.test(cause.message)) {
      return error("That volume claim is registered to another home", 409);
    }
    throw cause;
  }
}

function replaceHome(
  store: UserAuthHomeStore,
  current: AuthHome,
  body: PutAuthHomeRequest,
  now: number
): Promise<AuthHome | null> {
  return store.update(current.id, {
    pvcName: body.pvcName,
    nodeName: body.nodeName,
    providers: body.providers,
    kindsEnabled: body.kindsEnabled,
    backgroundConsentAt: consentAt(current.backgroundConsentAt, body.backgroundConsent, now),
    maxConcurrent: body.maxConcurrent,
    shared: body.shared,
    sharingConsentAt: consentAt(current.sharingConsentAt, body.shared, now),
    status: body.status,
    now,
  });
}

/** Registration writes one row; a replacement writes one row per consent flag that flipped. */
function auditHomeChange(ctx: UserRouteContext, before: AuthHome | null, after: AuthHome) {
  const base = {
    requestId: ctx.request_id,
    actorUserId: ctx.principal.userId,
    resourceType: "auth_home" as const,
    resourceId: after.id,
    metadata: { by: ctx.principal.userId },
  };
  if (!before) {
    return [
      bindAuthHomeAuditEvent(ctx.db, {
        ...base,
        action: "auth_home.registered",
        after: authHomeMetadataSchema.parse(stripPvcName(after)),
      }),
    ];
  }
  const statements = [];
  if ((before.backgroundConsentAt !== null) !== (after.backgroundConsentAt !== null)) {
    statements.push(
      bindAuthHomeAuditEvent(ctx.db, {
        ...base,
        action: "auth_home.consent_changed",
        before: { backgroundConsentAt: before.backgroundConsentAt },
        after: { backgroundConsentAt: after.backgroundConsentAt },
      })
    );
  }
  if (before.shared !== after.shared) {
    statements.push(
      bindAuthHomeAuditEvent(ctx.db, {
        ...base,
        action: "auth_home.sharing_changed",
        before: { shared: before.shared },
        after: { shared: after.shared },
        metadata: { ...base.metadata, from: before.shared, to: after.shared },
      })
    );
  }
  return statements;
}

async function deleteOwnHome(_request: Request, _env: Env, _params: object, ctx: UserRouteContext) {
  const store = new UserAuthHomeStore(ctx.db);
  const home = await store.findOwnedBy(ctx.principal.userId);
  if (!home) return error(NO_HOME, 404);
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM user_auth_homes WHERE id = ?").bind(home.id),
    bindAuthHomeAuditEvent(ctx.db, {
      requestId: ctx.request_id,
      actorUserId: ctx.principal.userId,
      action: "auth_home.removed",
      resourceType: "auth_home",
      resourceId: home.id,
      before: authHomeMetadataSchema.parse(stripPvcName(home)),
      metadata: { by: ctx.principal.userId },
    }),
  ]);
  return new Response(null, { status: 204 });
}

/** Every home without its volume name: who is enrolled, with what, and how it is shared. */
async function listHomes(_request: Request, _env: Env, _params: object, ctx: UserRouteContext) {
  const homes = await new UserAuthHomeStore(ctx.db).list();
  return json(
    authHomesResponseSchema.parse({
      homes: homes.map((home) => authHomeMetadataSchema.parse(stripPvcName(home))),
    })
  );
}

function stripPvcName(home: AuthHome): Omit<AuthHome, "pvcName"> {
  const { pvcName: _pvcName, ...metadata } = home;
  return metadata;
}

async function getSharing(_request: Request, _env: Env, _params: object, ctx: UserRouteContext) {
  return json(
    subscriptionSharingSchema.parse(await new SubscriptionSharingStore(ctx.db).getSnapshot())
  );
}

async function putSharing(request: Request, _env: Env, _params: object, ctx: UserRouteContext) {
  const body = await parseBody(request, putSubscriptionSharingRequestSchema, undefined);
  if (body instanceof Response) return body;
  const { previous, current } = await new SubscriptionSharingStore(ctx.db).set(
    body.policy,
    ctx.principal.userId
  );
  if (previous !== current.policy) {
    await bindAuthHomeAuditEvent(ctx.db, {
      requestId: ctx.request_id,
      actorUserId: ctx.principal.userId,
      action: "subscription_sharing.changed",
      resourceType: "subscription_sharing",
      resourceId: "global",
      before: { policy: previous },
      requested: { policy: body.policy },
      after: { policy: current.policy },
      metadata: { by: ctx.principal.userId, from: previous, to: current.policy },
    }).run();
  }
  return json(subscriptionSharingSchema.parse(current));
}

export const authHomeRoutes = new Hono<ControlPlaneHonoEnv>();
const self = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  cacheControl: PRIVATE_NO_STORE,
  authorization: requirePermission("auth_homes.manage_own", { service: "deny" }),
});
const readAll = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  cacheControl: PRIVATE_NO_STORE,
  authorization: requirePermission("auth_homes.read_all", { service: "deny" }),
});
const manageSharing = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  cacheControl: PRIVATE_NO_STORE,
  authorization: requirePermission("subscription_sharing.manage", { service: "deny" }),
});
authHomeRoutes.get("/me/auth-home", self, (c) => dispatch(c, getOwnHome));
authHomeRoutes.put("/me/auth-home", self, (c) => dispatch(c, putOwnHome));
authHomeRoutes.delete("/me/auth-home", self, (c) => dispatch(c, deleteOwnHome));
authHomeRoutes.get("/auth-homes", readAll, (c) => dispatch(c, listHomes));
authHomeRoutes.get("/subscription-sharing", self, (c) => dispatch(c, getSharing));
authHomeRoutes.put("/subscription-sharing", manageSharing, (c) => dispatch(c, putSharing));
