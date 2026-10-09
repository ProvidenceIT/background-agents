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
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import type { SqlDatabase } from "../db/sql-database";
import { createLogger } from "../logger";
import type { RequestContext } from "../http/request-context";
import { bindAuthHomePromptAudit } from "./audit";
import {
  authHomeSelectionSource,
  authHomesInForce,
  checkTurnEligibility,
  resolveAuthHome,
} from "./resolver";
import { SubscriptionSharingStore, UserAuthHomeStore } from "./store";

const logger = createLogger("auth-homes:session-binding");

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

/** Which entry point admitted a later turn; recorded on `credential.auth_home_prompt`. */
export type AuthHomeTurnChannel =
  "prompt" | "ws_token" | "ws_prompt" | "sandbox_access" | "slack_steer";

/** Why a later turn may not run on the session's home. */
export interface AuthHomeTurnRefusal {
  reason: AuthHomeRefusalReason;
  provider: string;
  message: string;
}

/** Thrown by a prompt path that cannot answer with an HTTP response (a WebSocket prompt). */
export class AuthHomeTurnRefusedError extends Error {
  constructor(readonly refusal: AuthHomeTurnRefusal) {
    super(refusal.message);
    this.name = "AuthHomeTurnRefusedError";
  }
}

export interface AuthHomeTurnInput {
  db: SqlDatabase;
  requestId: string;
  sessionId: string;
  /** The session row when the caller already holds it. */
  session?: Pick<SessionEntry, "authHomeId" | "model" | "triggerKind"> | null;
  /** The canonical user taking this turn; null for an anonymous or unlinked actor. */
  actorUserId: string | null;
  triggerKind: TriggerKind;
  /** A model the turn switches to; the session's model otherwise. */
  model?: string | null;
  channel: AuthHomeTurnChannel;
}

function turnRefusal(reason: AuthHomeRefusalReason, provider: string): AuthHomeTurnRefusal {
  return { reason, provider, message: authHomeRefusalMessage(reason, provider) };
}

/**
 * The per-turn gate: a session bound to a home serves a later turn only for
 * an actor eligible for that home under the current policy, and only on a
 * provider the home carries. Returns the refusal, or null to proceed (and
 * then records `credential.auth_home_prompt`). Sessions without a home are
 * not gated here. Every path that adds a turn to a session runs it: the
 * HTTP prompt route, a WebSocket prompt, a Slack thread steer.
 */
export async function admitAuthHomeTurn(
  input: AuthHomeTurnInput
): Promise<AuthHomeTurnRefusal | null> {
  const session =
    input.session === undefined
      ? await new SessionIndexStore(input.db).get(input.sessionId)
      : input.session;
  const homeId = session?.authHomeId;
  if (!session || !homeId) return null;

  const provider = providerForModel(input.model ?? session.model);
  const home = await new UserAuthHomeStore(input.db).getById(homeId);
  if (home && !(home.providers as readonly string[]).includes(provider)) {
    return turnRefusal("no_eligible_home", provider);
  }
  const resolution = await checkTurnEligibility({
    db: input.db,
    actorUserId: input.actorUserId,
    homeId,
    triggerKind: input.triggerKind,
    provider,
    sessionProvider: providerForModel(session.model),
  });
  if (resolution.kind === "refused") {
    logger.info("auth_home.turn_refused", {
      session_id: input.sessionId,
      home_id: homeId,
      reason: resolution.reason,
      channel: input.channel,
      request_id: input.requestId,
    });
    return turnRefusal(resolution.reason, provider);
  }
  await bindAuthHomePromptAudit({
    db: input.db,
    requestId: input.requestId,
    actorUserId: input.actorUserId,
    sessionId: input.sessionId,
    provider,
    triggerKind: input.triggerKind,
    homeId,
    homeOwnerUserId: resolution.homeOwnerUserId,
    selection: resolution.kind,
    channel: input.channel,
  }).run();
  return null;
}

/** `admitAuthHomeTurn` for an HTTP route: the refusal as the response to send. */
export async function enforceAuthHomeTurn(input: AuthHomeTurnInput): Promise<Response | null> {
  const refusal = await admitAuthHomeTurn(input);
  return refusal ? authHomeRefusalResponse(refusal.reason, refusal.provider) : null;
}

/**
 * The trigger kind of a later turn, by who sends it: a person always
 * prompts; a bot relays and names the kind (`mention`, `issue_label`,
 * `pr_event`), or else is taken to relay a mention. GitHub's bot only relays
 * pull-request events.
 */
export function turnTriggerKind(
  principal: RequestContext["principal"],
  named?: TriggerKind
): TriggerKind {
  if (principal?.kind !== "service" || principal.service === "web") return "prompt";
  if (named) return named;
  return principal.service === "github-bot" ? "pr_event" : "mention";
}

/** Kinds a bot may name for a later turn; `child` and `schedule` are the control plane's. */
export const BOT_TURN_TRIGGER_KINDS: readonly TriggerKind[] = [
  "prompt",
  "mention",
  "issue_label",
  "pr_event",
];

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
