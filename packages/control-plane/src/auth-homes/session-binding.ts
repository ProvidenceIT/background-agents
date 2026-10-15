import {
  authHomeProviderForModel,
  authHomeRefusalMessage,
  NO_ELIGIBLE_HOME,
  type AuthHome,
  type AuthHomeRefusalReason,
  type AuthHomeResolution,
  type TriggerKind,
} from "@open-inspect/shared/types/auth-homes";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import { extractProviderAndModel } from "@open-inspect/shared/models";
import type { SessionModelProviderAuthInput } from "../model-provider-accounts/provider-auth-contracts";
import type { SqlDatabase } from "../db/sql-database";
import { authHomeSelectionSource, authHomesInForce, resolveAuthHome } from "./resolver";
import { SubscriptionSharingStore, UserAuthHomeStore } from "./store";

/** The provider whose home rules include private repositories only. */
const PRIVATE_REPO_PROVIDER = "openai";

type ServedResolution = Extract<AuthHomeResolution, { kind: "own" | "shared" }>;
type RefusedResolution = Extract<AuthHomeResolution, { kind: "refused" }>;

/** The home binding of a new session, or why it has none. */
export type SessionAuthHomeBinding =
  /** No home is registered anywhere: the installation's legacy provider paths apply. */
  | { kind: "not_in_force" }
  | { kind: "served"; provider: string; home: AuthHome; resolution: ServedResolution }
  | { kind: "refused"; provider: string; resolution: RefusedResolution };

export interface BindSessionAuthHomeInput {
  actorUserId: string | null;
  model: string;
  triggerKind: TriggerKind;
  /** Asked only when the provider's home rules depend on repository visibility. */
  repoPrivate: () => Promise<boolean | null>;
  workItemAuthorUserId?: string | null;
  automationConsentAt?: number | null;
  /** The session's harness; Codex queues for a busy home rather than being refused. */
  harness?: HarnessId;
}

/** The provider id a model spends, as the registry names it. */
export function providerForModel(model: string): string {
  return authHomeProviderForModel(model) ?? extractProviderAndModel(model).provider;
}

/** Resolve the home a new session will mount (create, child spawn, scheduled run). */
export async function bindSessionAuthHome(
  db: SqlDatabase,
  input: BindSessionAuthHomeInput
): Promise<SessionAuthHomeBinding> {
  if (!(await authHomesInForce(db))) return { kind: "not_in_force" };
  const provider = providerForModel(input.model);
  const resolution = await resolveAuthHome({
    db,
    actorUserId: input.actorUserId,
    provider,
    triggerKind: input.triggerKind,
    repoPrivate: provider === PRIVATE_REPO_PROVIDER ? await input.repoPrivate() : null,
    workItemAuthorUserId: input.workItemAuthorUserId,
    automationConsentAt: input.automationConsentAt,
    harness: input.harness,
  });
  if (resolution.kind === "refused") return { kind: "refused", provider, resolution };
  const home = await new UserAuthHomeStore(db).getById(resolution.homeId);
  if (!home) {
    return {
      kind: "refused",
      provider,
      resolution: { kind: "refused", reason: "auth_home_unavailable" },
    };
  }
  return { kind: "served", provider, home, resolution };
}

/**
 * Bind every provider the home carries to it; the others keep what the
 * installation resolved. The model's provider is always carried (the
 * resolver chose the home for it).
 */
export function applyAuthHomeToProviderAuth(
  providerAuth: readonly SessionModelProviderAuthInput[],
  binding: Extract<SessionAuthHomeBinding, { kind: "served" }>
): SessionModelProviderAuthInput[] {
  const carried = new Set<string>(binding.home.providers);
  const selectionSource = authHomeSelectionSource(binding.resolution);
  return providerAuth.map((auth) =>
    carried.has(auth.provider)
      ? { provider: auth.provider, authMode: "auth_home", selectionSource }
      : auth
  );
}

/**
 * The refusal a caller receives. `public_repo` is a property of the request
 * (400); every other reason is the 403 the bots recognise by its code.
 */
export function authHomeRefusalResponse(reason: AuthHomeRefusalReason, provider: string): Response {
  const message = authHomeRefusalMessage(reason, provider);
  const publicRepo = reason === "public_repo";
  return Response.json(
    { error: message, message, code: publicRepo ? reason : NO_ELIGIBLE_HOME, reason },
    { status: publicRepo ? 400 : 403 }
  );
}

/** Error code of the 409 that keeps an unshared home's session from being widened. */
export const AUTH_HOME_NOT_SHARED = "auth_home_not_shared";

/**
 * Whether the sessions bound to `homeId` must stay private to their owner:
 * under `owner_only`, or while the home is not shared, nobody else may take
 * a turn on it, so the session may not be widened to others either.
 */
export async function authHomeKeepsSessionsPrivate(
  db: SqlDatabase,
  homeId: string | null | undefined
): Promise<boolean> {
  if (!homeId) return false;
  const home = await new UserAuthHomeStore(db).getById(homeId);
  return home ? homeKeepsSessionsPrivate(db, home) : false;
}

async function homeKeepsSessionsPrivate(db: SqlDatabase, home: AuthHome): Promise<boolean> {
  if (!home.shared) return true;
  return (await new SubscriptionSharingStore(db).get()) !== "household";
}

/**
 * The visibility a new session gets: what was asked for, unless it is bound
 * to a home that keeps its sessions private (`authHomeKeepsSessionsPrivate`).
 * Nobody else may take a turn on such a session, so it is not listed to them
 * either. Applied at create, child spawn and scheduled run.
 */
export async function authHomeSessionVisibility<V extends string>(
  db: SqlDatabase,
  binding: SessionAuthHomeBinding,
  requested: V
): Promise<V | "private"> {
  if (binding.kind !== "served") return requested;
  return (await homeKeepsSessionsPrivate(db, binding.home)) ? "private" : requested;
}

/** The 409 for widening a session that `authHomeKeepsSessionsPrivate` holds private. */
export function authHomeNotSharedResponse(): Response {
  return Response.json(
    {
      error:
        "This session runs on a subscription home that is not shared, so it stays private to its owner",
      code: AUTH_HOME_NOT_SHARED,
    },
    { status: 409 }
  );
}
