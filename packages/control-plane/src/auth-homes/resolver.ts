import {
  authHomeOwnerUserId,
  CODEX_SEAT,
  AUTH_HOME_SELECTION_SOURCES,
  type AuthHome,
  type AuthHomeRefusalReason,
  type AuthHomeResolution,
  type AuthHomeSelectionSource,
  type SubscriptionSharingPolicy,
  type TriggerKind,
} from "@open-inspect/shared/types/auth-homes";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import type { SqlDatabase } from "../db/sql-database";
import { SubscriptionSharingStore, UserAuthHomeStore } from "./store";

/**
 * The subscription auth-home resolver: which home, if any, serves a turn.
 *
 * 1. The actor's own active home carrying the provider.
 * 2. Else, under the `household` policy and only for an enrolled actor (one
 *    who owns an active home), a home another enrolled person switched to
 *    `shared` that carries the provider: fewest running sessions first, then
 *    the oldest registration. Quota state never enters the order.
 * 3. Else a refusal. There is no API key to fall back on.
 *
 * Gates inside the chosen home: the trigger kind must be enabled; OpenAI (the
 * Codex path) serves private repositories only and needs background consent
 * (the home's, and the automation's on a scheduled run) for every kind but
 * `prompt`; a home already running `maxConcurrent` turns is unavailable,
 * except to a Codex session, which waits for the home's Codex seat instead.
 */

/** The provider whose subscription is spent through Codex, with its stricter gates. */
const CODEX_PROVIDER = "openai";

/** Sessions in this status are running a turn on their home. */
const RUNNING_STATUS = "active";

export interface ResolveAuthHomeInput {
  db: SqlDatabase;
  /** The canonical trigger actor; null (an unlinked bot actor) is never served. */
  actorUserId: string | null;
  /** The model's provider (`anthropic`, `openai`, `zai-coding-plan`, ...). */
  provider: string;
  triggerKind: TriggerKind;
  /** Whether every repository of the session is private; null when unknown. */
  repoPrivate: boolean | null;
  /** Audited only, never gated (decision F). */
  workItemAuthorUserId?: string | null;
  /**
   * The automation's own background consent on a scheduled run; leave
   * undefined for turns that are not automation runs.
   */
  automationConsentAt?: number | null;
  /**
   * The session's harness. A Codex session is not refused for a busy home:
   * it queues for the home's Codex seat at launch (`lease.ts`), which holds
   * Codex to one running session per home whatever `maxConcurrent` says.
   */
  harness?: HarnessId | null;
}

/** The registry state one resolution reads; loaded once per call. */
interface RegistrySnapshot {
  policy: SubscriptionSharingPolicy;
  homes: AuthHome[];
  running: ReadonlyMap<string, number>;
}

async function countRunningSessions(
  db: SqlDatabase,
  homeIds: readonly string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (homeIds.length === 0) return counts;
  const rows = await db
    .prepare(
      `SELECT auth_home_id, COUNT(*) AS running FROM sessions
       WHERE status = ? AND auth_home_id IN (${homeIds.map(() => "?").join(", ")})
       GROUP BY auth_home_id`
    )
    .bind(RUNNING_STATUS, ...homeIds)
    .all<{ auth_home_id: string; running: number }>();
  for (const row of rows.results ?? []) counts.set(row.auth_home_id, Number(row.running));
  return counts;
}

async function loadSnapshot(db: SqlDatabase): Promise<RegistrySnapshot> {
  const [policy, homes] = await Promise.all([
    new SubscriptionSharingStore(db).get(),
    new UserAuthHomeStore(db).list(),
  ]);
  const running = await countRunningSessions(
    db,
    homes.map((home) => home.id)
  );
  return { policy, homes, running };
}

/**
 * Whether the auth-home rules govern this installation: once any home is
 * registered every session resolves through a home or is refused. A
 * deployment that never enrols a home keeps its provider-account and
 * API-key paths unchanged.
 */
export async function authHomesInForce(db: SqlDatabase): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS present FROM user_auth_homes LIMIT 1").bind().first();
  return row !== null;
}

function owns(home: AuthHome, userId: string): boolean {
  return home.ownerUserIds.includes(userId);
}

function refused(reason: AuthHomeRefusalReason, home?: AuthHome): AuthHomeResolution {
  return home
    ? { kind: "refused", reason, homeId: home.id, homeOwnerUserId: authHomeOwnerUserId(home) }
    : { kind: "refused", reason };
}

/** The first gate a home fails for this turn, or null when it may serve it. */
function gateFailure(
  home: AuthHome,
  input: ResolveAuthHomeInput,
  running: number
): AuthHomeRefusalReason | null {
  if (!home.kindsEnabled.includes(input.triggerKind)) return "kind_disabled";
  if (input.provider === CODEX_PROVIDER) {
    if (input.repoPrivate !== true) return "public_repo";
    if (input.triggerKind !== "prompt") {
      if (home.backgroundConsentAt === null) return "no_consent";
      if (input.automationConsentAt === null) return "no_consent";
    }
  }
  const seated = input.provider === CODEX_PROVIDER && input.harness === CODEX_SEAT;
  if (!seated && running >= home.maxConcurrent) return "auth_home_unavailable";
  return null;
}

function served(kind: "own" | "shared", home: AuthHome): AuthHomeResolution {
  return { kind, homeId: home.id, homeOwnerUserId: authHomeOwnerUserId(home) };
}

/** Resolve the home that serves a new session (create, child spawn, scheduled run). */
export async function resolveAuthHome(input: ResolveAuthHomeInput): Promise<AuthHomeResolution> {
  const actor = input.actorUserId;
  if (!actor) return refused("no_eligible_home");
  const { policy, homes, running } = await loadSnapshot(input.db);
  const active = homes.filter((home) => home.status === "active");
  const carrying = active.filter((home) =>
    (home.providers as readonly string[]).includes(input.provider)
  );
  const runningOn = (home: AuthHome) => running.get(home.id) ?? 0;

  const own = carrying.find((home) => owns(home, actor));
  if (own) {
    const failure = gateFailure(own, input, runningOn(own));
    return failure ? refused(failure, own) : served("own", own);
  }

  const enrolled = active.some((home) => owns(home, actor));
  if (policy !== "household" || !enrolled) return refused("no_eligible_home");

  // Stable sort keeps the store's oldest-registration order between equal counts.
  const shared = carrying.filter((home) => home.shared).sort((a, b) => runningOn(a) - runningOn(b));
  let firstFailure: AuthHomeResolution | null = null;
  for (const home of shared) {
    const failure = gateFailure(home, input, runningOn(home));
    if (!failure) return served("shared", home);
    firstFailure ??= refused(failure, home);
  }
  if (firstFailure) return firstFailure;

  const unshared = carrying.find((home) => !home.shared);
  return unshared ? refused("sharing_off", unshared) : refused("no_eligible_home");
}

export interface CheckTurnEligibilityInput {
  db: SqlDatabase;
  /** The canonical user prompting this turn. */
  actorUserId: string | null;
  /** The home recorded on the session at create. */
  homeId: string;
}

/**
 * Whether `actorUserId` may spend the session's home on a later turn under the
 * current policy: its owner always; under `household`, any enrolled person
 * when the home is shared. A session's home is fixed at create, so this never
 * picks another home, and concurrency is not re-counted (the session already
 * holds its place).
 */
export async function checkTurnEligibility(
  input: CheckTurnEligibilityInput
): Promise<AuthHomeResolution> {
  const store = new UserAuthHomeStore(input.db);
  const home = await store.getById(input.homeId);
  if (!home || home.status !== "active") return refused("auth_home_unavailable", home ?? undefined);
  const actor = input.actorUserId;
  if (!actor) return refused("no_eligible_home", home);
  if (owns(home, actor)) return served("own", home);

  const [policy, actorHomes] = await Promise.all([
    new SubscriptionSharingStore(input.db).get(),
    store.listForUser(actor),
  ]);
  const enrolled = actorHomes.some((candidate) => candidate.status === "active");
  if (policy !== "household" || !enrolled) return refused("no_eligible_home", home);
  if (!home.shared) return refused("sharing_off", home);
  return served("shared", home);
}

/** The `selection_source` a served resolution writes on `session_model_provider_auth`. */
export function authHomeSelectionSource(
  resolution: Extract<AuthHomeResolution, { kind: "own" | "shared" }>
): AuthHomeSelectionSource {
  return AUTH_HOME_SELECTION_SOURCES[resolution.kind];
}
