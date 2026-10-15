/**
 * Turn admission: whether a turn may run on its session's bound subscription
 * home, for this actor and trigger kind, and the audit of a turn the home
 * served. Every later turn passes through the session's prompt queue, so
 * admission happens there, wrapped around the enqueue (ADR 0005): home gate,
 * then usage quota, then the enqueue, then `credential.auth_home_prompt` for
 * a turn that was actually added. Worker routes do not gate later turns;
 * they work out the actor and trigger kind and pass them through.
 *
 * An access check (opening the session's socket, entering its sandbox) uses
 * the same eligibility rule without recording a served turn.
 */

import type { AuthHomeRefusalReason, TriggerKind } from "@open-inspect/shared/types/auth-homes";
import { authHomeRefusalMessage } from "@open-inspect/shared/types/auth-homes";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import type { SqlDatabase } from "../db/sql-database";
import type { RequestContext } from "../http/request-context";
import { createLogger } from "../logger";
import { bindAuthHomePromptAudit } from "./audit";
import { authHomesInForce, checkTurnEligibility } from "./resolver";
import { authHomeRefusalResponse, providerForModel } from "./session-binding";
import { UserAuthHomeStore } from "./store";

const logger = createLogger("auth-homes:turn-admission");

/** Which entry point added a turn; recorded on `credential.auth_home_prompt`. */
export type TurnChannel = "prompt" | "ws_prompt" | "slack_steer" | "child_prompt" | "autofix";

/** Why a turn may not run on the session's home. */
export interface AuthHomeTurnRefusal {
  reason: AuthHomeRefusalReason;
  provider: string;
  message: string;
}

/** Thrown by turn admission to refuse; the prompt path renders it for its transport. */
export class AuthHomeTurnRefusedError extends Error {
  constructor(readonly refusal: AuthHomeTurnRefusal) {
    super(refusal.message);
    this.name = "AuthHomeTurnRefusedError";
  }
}

/** The HTTP response for a refused turn: the status, code and message the bots recognise. */
export function authHomeTurnRefusalResponse(error: AuthHomeTurnRefusedError): Response {
  return authHomeRefusalResponse(error.refusal.reason, error.refusal.provider);
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

/** Who takes a turn: a canonical user (null when unlinked), or the session's owner. */
type TurnActor = { userId: string | null } | "session_owner";

interface HomeTurnQuery {
  db: SqlDatabase;
  sessionId: string;
  /** The session row when the caller already holds it. */
  session?: Pick<SessionEntry, "authHomeId" | "model" | "userId"> | null;
  actor: TurnActor;
  triggerKind: TriggerKind;
  /** A model the turn switches to; the session's model otherwise. */
  model?: string | null;
}

type HomeTurnDecision =
  | { kind: "unbound" }
  | { kind: "refused"; refusal: AuthHomeTurnRefusal }
  | {
      kind: "served";
      homeId: string;
      homeOwnerUserId: string;
      selection: "own" | "shared";
      provider: string;
      actorUserId: string;
    };

function refusal(reason: AuthHomeRefusalReason, provider: string): HomeTurnDecision {
  return {
    kind: "refused",
    refusal: { reason, provider, message: authHomeRefusalMessage(reason, provider) },
  };
}

/**
 * The home's decision for one turn: a session bound to a home serves it only
 * for an actor eligible for that home under the current policy, under the
 * home's kind and consent gates, and only on a provider the home carries.
 * Sessions without a home are not gated.
 */
async function decideHomeTurn(query: HomeTurnQuery): Promise<HomeTurnDecision> {
  if (!(await authHomesInForce(query.db))) return { kind: "unbound" };
  const session =
    query.session === undefined
      ? await new SessionIndexStore(query.db).get(query.sessionId)
      : query.session;
  const homeId = session?.authHomeId;
  if (!session || !homeId) return { kind: "unbound" };

  const provider = providerForModel(query.model ?? session.model);
  const home = await new UserAuthHomeStore(query.db).getById(homeId);
  if (home && !(home.providers as readonly string[]).includes(provider)) {
    return refusal("no_eligible_home", provider);
  }
  const actorUserId = query.actor === "session_owner" ? session.userId : query.actor.userId;
  const resolution = await checkTurnEligibility({
    db: query.db,
    actorUserId: actorUserId ?? null,
    homeId,
    triggerKind: query.triggerKind,
    provider,
    sessionProvider: providerForModel(session.model),
  });
  if (resolution.kind === "refused") return refusal(resolution.reason, provider);
  return {
    kind: "served",
    homeId,
    homeOwnerUserId: resolution.homeOwnerUserId,
    selection: resolution.kind,
    provider,
    actorUserId: actorUserId!,
  };
}

/**
 * Whether `actorUserId` may reach the session's home without taking a turn
 * (its socket, its sandbox): the turn eligibility rule, with nothing
 * recorded. Returns the refusal response to send, or null to proceed.
 */
export async function checkAuthHomeAccess(
  query: Omit<HomeTurnQuery, "actor" | "model"> & { actorUserId: string | null }
): Promise<Response | null> {
  const decision = await decideHomeTurn({ ...query, actor: { userId: query.actorUserId } });
  if (decision.kind !== "refused") return null;
  logger.info("auth_home.access_refused", {
    session_id: query.sessionId,
    reason: decision.refusal.reason,
  });
  return authHomeRefusalResponse(decision.refusal.reason, decision.refusal.provider);
}

/** The home check for a later turn. */
export interface HomeTurn {
  actor: TurnActor;
  triggerKind: TriggerKind;
  model: string | null;
  channel: TurnChannel;
  requestId: string;
}

export interface TurnRequest {
  /**
   * The home check for this turn, or `admitted_at_create`: the session's
   * creation (child spawn, scheduled run) bound the home and audited its
   * first turn.
   */
  home: HomeTurn | "admitted_at_create";
  /** Whose usage quota the turn spends; omitted for a turn that is not metered. */
  meteredUserId?: string;
}

/** What an enqueue reports back: its result, and whether it added a new turn (not a replay). */
export interface EnqueuedTurn<T> {
  value: T;
  added: boolean;
}

/** The prompt queue's view of turn admission. */
export interface TurnAdmissionGate {
  /**
   * Admit the turn and run `enqueue`; throws `AuthHomeTurnRefusedError` or
   * `UsageQuotaExceededError` (before enqueueing) to refuse.
   */
  admit<T>(request: TurnRequest, enqueue: () => Promise<EnqueuedTurn<T>>): Promise<T>;
}

/** Admits every turn: a queue with no control-plane database behind it (tests, local runtimes). */
export const ADMIT_EVERY_TURN: TurnAdmissionGate = {
  admit: async (_request, enqueue) => (await enqueue()).value,
};

export interface TurnAdmissionDeps {
  db: SqlDatabase;
  /** The session's public id, once it is known. */
  getSessionId: () => string | null;
  /** Throws `UsageQuotaExceededError` when the user's usage quota refuses the turn. */
  admitUsage: (input: { userId: string; sessionId: string; requestId: string }) => Promise<void>;
}

/** Turn admission for one session's prompt queue. */
export class TurnAdmission implements TurnAdmissionGate {
  constructor(private readonly deps: TurnAdmissionDeps) {}

  async admit<T>(request: TurnRequest, enqueue: () => Promise<EnqueuedTurn<T>>): Promise<T> {
    const sessionId = this.deps.getSessionId();
    if (!sessionId) return (await enqueue()).value;
    const home = request.home === "admitted_at_create" ? null : request.home;
    const requestId = home?.requestId ?? crypto.randomUUID();

    const decision = home
      ? await decideHomeTurn({
          db: this.deps.db,
          sessionId,
          actor: home.actor,
          triggerKind: home.triggerKind,
          model: home.model,
        })
      : ({ kind: "unbound" } as const);
    if (decision.kind === "refused") {
      logger.info("auth_home.turn_refused", {
        session_id: sessionId,
        reason: decision.refusal.reason,
        channel: home?.channel,
        request_id: requestId,
      });
      throw new AuthHomeTurnRefusedError(decision.refusal);
    }
    if (request.meteredUserId) {
      await this.deps.admitUsage({ userId: request.meteredUserId, sessionId, requestId });
    }

    const enqueued = await enqueue();
    if (decision.kind === "served" && home && enqueued.added) {
      await this.recordServed(sessionId, home, decision);
    }
    return enqueued.value;
  }

  /**
   * `credential.auth_home_prompt` for a turn the home served. The turn is
   * already queued, so a failed write is logged rather than refusing it.
   */
  private async recordServed(
    sessionId: string,
    home: HomeTurn,
    decision: Extract<HomeTurnDecision, { kind: "served" }>
  ): Promise<void> {
    try {
      await bindAuthHomePromptAudit({
        db: this.deps.db,
        requestId: home.requestId,
        actorUserId: decision.actorUserId,
        sessionId,
        provider: decision.provider,
        triggerKind: home.triggerKind,
        homeId: decision.homeId,
        homeOwnerUserId: decision.homeOwnerUserId,
        selection: decision.selection,
        channel: home.channel,
      }).run();
    } catch (error) {
      logger.error("auth_home.prompt_audit_failed", {
        session_id: sessionId,
        home_id: decision.homeId,
        request_id: home.requestId,
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}
