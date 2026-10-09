import { Hono } from "hono";
import {
  authHomeClaimResponseSchema,
  authHomeClaimsResponseSchema,
  authHomeMetadataSchema,
  authHomeOwnerUserId,
  authHomePvcNameSchema,
  authHomeResponseSchema,
  authHomeSeatResponseSchema,
  CODEX_SEAT,
  authHomesResponseSchema,
  putAuthHomeClaimRequestSchema,
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
import { AuthHomeLeaseStore } from "./lease";
import {
  AuthHomeClaimStore,
  AuthHomeValidationError,
  SubscriptionSharingStore,
  UserAuthHomeStore,
} from "./store";

/**
 * Subscription auth-home routes.
 *
 * `/me/auth-home` is the caller's own registration and nothing else: the
 * owner is the admitted user, the body never names one, and no route reads
 * another person's home by id. The volume claim it names must have been
 * assigned to the caller by an operator (`/auth-home-claims`), and it is
 * fixed once registered. `/auth-homes` lists metadata (no volume
 * names) for the roles that administer the workspace. `/subscription-sharing`
 * is the one workspace-wide switch. `/me/auth-home/lease` is the Codex seat of
 * the caller's home: the UI's "waiting for your Codex seat".
 */

const PRIVATE_NO_STORE = "private, no-store" as const;
const NO_HOME = "No subscription home is registered for you";
const CLAIM_NOT_YOURS =
  "That volume claim is not assigned to you; ask an operator to assign your home's claim";
const CLAIM_FIXED =
  "A registered home's volume claim cannot be changed; remove the home to register another claim";

function consentAt(current: number | null, consented: boolean, now: number): number | null {
  if (!consented) return null;
  return current ?? now;
}

/** Of `sessionIds`, those the user created or triggered: the only ones the seat names to them. */
async function sessionsOf(
  ctx: UserRouteContext,
  sessionIds: readonly string[]
): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const placeholders = sessionIds.map(() => "?").join(", ");
  const rows = await ctx.db
    .prepare(
      `SELECT id FROM sessions
       WHERE id IN (${placeholders}) AND (user_id = ? OR trigger_actor_user_id = ?)`
    )
    .bind(...sessionIds, ctx.principal.userId, ctx.principal.userId)
    .all<{ id: string }>();
  return new Set((rows.results ?? []).map((row) => row.id));
}

/** The Codex seat of the caller's home: who runs, who waits, and in what order. */
async function getOwnSeat(_request: Request, _env: Env, _params: object, ctx: UserRouteContext) {
  const home = await new UserAuthHomeStore(ctx.db).findOwnedBy(ctx.principal.userId);
  if (!home) return error(NO_HOME, 404);
  const [status] = await new AuthHomeLeaseStore(ctx.db).status([home.id], CODEX_SEAT);
  const holder = status?.holder ?? null;
  const waiting = status?.waiting ?? [];
  const mine = await sessionsOf(ctx, [
    ...(holder ? [holder.sessionId] : []),
    ...waiting.map((waiter) => waiter.sessionId),
  ]);
  const occupant = (sessionId: string) => ({
    sessionId: mine.has(sessionId) ? sessionId : null,
    mine: mine.has(sessionId),
  });
  return json(
    authHomeSeatResponseSchema.parse({
      seat: {
        homeId: home.id,
        seat: CODEX_SEAT,
        holder: holder
          ? {
              ...occupant(holder.sessionId),
              acquiredAt: holder.acquiredAt,
              heartbeatAt: holder.heartbeatAt,
              fencing: holder.fencedAt !== null,
            }
          : null,
        waiting: waiting.map((waiter) => ({
          ...occupant(waiter.sessionId),
          position: waiter.position,
          enqueuedAt: waiter.enqueuedAt,
        })),
      },
    })
  );
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
  if (current && current.pvcName !== body.pvcName) return error(CLAIM_FIXED, 409);
  if (!current) {
    // The claim names a volume on a node; only the operator who created it
    // knows whose credentials it holds, so the caller must have been
    // assigned it. Nothing in the body can make another person's volume
    // the caller's.
    const claim = await new AuthHomeClaimStore(ctx.db).get(body.pvcName);
    if (claim?.ownerUserId !== actorUserId) return error(CLAIM_NOT_YOURS, 403);
  }
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

/** Every claim assignment: which person each home volume belongs to. */
async function listClaims(_request: Request, _env: Env, _params: object, ctx: UserRouteContext) {
  const claims = await new AuthHomeClaimStore(ctx.db).list();
  return json(authHomeClaimsResponseSchema.parse({ claims }));
}

function parseClaimName(params: { pvcName: string }): string | Response {
  const parsed = authHomePvcNameSchema.safeParse(params.pvcName);
  return parsed.success ? parsed.data : error(`pvcName: ${parsed.error.issues[0]?.message}`, 400);
}

/**
 * Assign a home claim to the person whose credentials its volume holds. A
 * claim already registered as someone's home keeps its owner: reassigning
 * it would hand that person's volume to another.
 */
async function putClaim(
  request: Request,
  _env: Env,
  params: { pvcName: string },
  ctx: UserRouteContext
) {
  const pvcName = parseClaimName(params);
  if (pvcName instanceof Response) return pvcName;
  const body = await parseBody(request, putAuthHomeClaimRequestSchema, undefined);
  if (body instanceof Response) return body;
  const user = await ctx.db
    .prepare("SELECT id FROM users WHERE id = ?")
    .bind(body.ownerUserId)
    .first<{ id: string }>();
  if (!user) return error("No such user", 404);
  const claims = new AuthHomeClaimStore(ctx.db);
  const [before, home] = await Promise.all([
    claims.get(pvcName),
    new UserAuthHomeStore(ctx.db).findByPvcName(pvcName),
  ]);
  if (home && authHomeOwnerUserId(home) !== body.ownerUserId) {
    return error("That claim is registered as another person's home", 409);
  }
  const claim = await claims.assign({
    pvcName,
    ownerUserId: body.ownerUserId,
    assignedBy: ctx.principal.userId,
  });
  if (before?.ownerUserId !== claim.ownerUserId) {
    await bindAuthHomeAuditEvent(ctx.db, {
      requestId: ctx.request_id,
      actorUserId: ctx.principal.userId,
      action: "auth_home.claim_assigned",
      resourceType: "auth_home",
      resourceId: null,
      targetUserId: claim.ownerUserId,
      before: { ownerUserId: before?.ownerUserId ?? null },
      requested: { ownerUserId: body.ownerUserId },
      after: { ownerUserId: claim.ownerUserId },
      metadata: {
        by: ctx.principal.userId,
        from: before?.ownerUserId ?? null,
        to: claim.ownerUserId,
      },
    }).run();
  }
  return json(authHomeClaimResponseSchema.parse({ claim }));
}

/** Withdraw an assignment; refused while a home is registered on the claim. */
async function deleteClaim(
  _request: Request,
  _env: Env,
  params: { pvcName: string },
  ctx: UserRouteContext
) {
  const pvcName = parseClaimName(params);
  if (pvcName instanceof Response) return pvcName;
  const claims = new AuthHomeClaimStore(ctx.db);
  const claim = await claims.get(pvcName);
  if (!claim) return error("That claim is not assigned", 404);
  if (await new UserAuthHomeStore(ctx.db).findByPvcName(pvcName)) {
    return error("That claim is registered as a home; its owner must remove the home first", 409);
  }
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM auth_home_claims WHERE pvc_name = ?").bind(pvcName),
    bindAuthHomeAuditEvent(ctx.db, {
      requestId: ctx.request_id,
      actorUserId: ctx.principal.userId,
      action: "auth_home.claim_unassigned",
      resourceType: "auth_home",
      resourceId: null,
      targetUserId: claim.ownerUserId,
      before: { ownerUserId: claim.ownerUserId },
      after: { ownerUserId: null },
      metadata: { by: ctx.principal.userId, from: claim.ownerUserId, to: null },
    }),
  ]);
  return new Response(null, { status: 204 });
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
const assignClaims = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  cacheControl: PRIVATE_NO_STORE,
  authorization: requirePermission("auth_homes.assign", { service: "deny" }),
});
authHomeRoutes.get("/me/auth-home", self, (c) => dispatch(c, getOwnHome));
authHomeRoutes.put("/me/auth-home", self, (c) => dispatch(c, putOwnHome));
authHomeRoutes.delete("/me/auth-home", self, (c) => dispatch(c, deleteOwnHome));
authHomeRoutes.get("/me/auth-home/lease", self, (c) => dispatch(c, getOwnSeat));
authHomeRoutes.get("/auth-homes", readAll, (c) => dispatch(c, listHomes));
authHomeRoutes.get("/subscription-sharing", self, (c) => dispatch(c, getSharing));
authHomeRoutes.put("/subscription-sharing", manageSharing, (c) => dispatch(c, putSharing));
authHomeRoutes.get("/auth-home-claims", assignClaims, (c) => dispatch(c, listClaims));
authHomeRoutes.put("/auth-home-claims/:pvcName", assignClaims, (c) => dispatch(c, putClaim));
authHomeRoutes.delete("/auth-home-claims/:pvcName", assignClaims, (c) => dispatch(c, deleteClaim));
