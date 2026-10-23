import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { RepositoryRef, RepositoryPair } from "@open-inspect/shared/types/repositories";
import {
  checkHarnessCompatibility,
  harnessForModel,
  isValidHarness,
} from "@open-inspect/shared/harnesses";
import { getValidModelOrDefault, isValidReasoningEffort } from "@open-inspect/shared/models";
import {
  SUBSCRIPTION_SLOT_UNAVAILABLE,
  type CreateSessionInput,
  type CreateSessionResponse,
} from "@open-inspect/shared/types/session-api";
import type { SessionStatus, SpawnSource } from "@open-inspect/shared/types/sessions";
import { generateId } from "../auth/crypto";
import { resolveGitHubCredentialAuthority } from "../source-control/github-credential-authority";
import {
  applyIdentityEnforcement,
  requireAdmittedCanonicalUserId,
} from "../routing/identity-enforcement";
import { resolveEnvironmentTarget, resolveSessionRepositories } from "../repos/resolve";
import { resolveScmProviderFromEnv } from "../source-control";
import { EnvironmentStore } from "../db/environments";
import { UserStore } from "../db/user-store";
import { TeamMembershipStore } from "../db/team-memberships";
import { createLogger } from "../logger";
import { parseCreateSessionInput } from "../session/create-session-input";
import { initializeSession, type SessionInitInput } from "../session/initialize";
import {
  EXTERNAL_REF_PENDING_LEASE_MS,
  EXTERNAL_REF_RETRY_AFTER_SECONDS,
  externalRefFingerprint,
  probeSessionRuntime,
  SessionExternalRefTakenError,
  type SessionExternalRef,
} from "../session/external-ref";
import { SessionIndexStore, type SessionForkOrigin } from "../db/session-index";
import { resolveGitHubEnrichmentForRequest } from "../session/identity";
import { resolveSessionScopedSettings } from "../session/integration-settings-resolution";
import { resolveManagedSkills, SkillResolutionError } from "../session/skill-resolution";
import { resolvedPin } from "../session/pinned";
import { createSessionMemorySelector } from "../memory/session-memory-selector-factory";
import type { Env } from "../types";
import { resolveSessionProviderAuth } from "../session/provider-account-resolution";
import { ProviderAccountSelectionPolicyError } from "../model-provider-accounts/selection-policy";
import { admitNewSession, newSessionRefusalResponse } from "../auth-homes/turn-admission";
import { repositoriesArePrivate } from "../auth-homes/repo-visibility";
import { resolveSessionTrigger } from "../auth-homes/session-trigger";
import { authorizeEnvironmentTarget, authorizeSessionTarget } from "./session-target-authorization";
import { resolveCreationOwnerTeam, teamRequiredResponse } from "./team-ownership";
import {
  normalizeOptionalRepositoryPair,
  RepositoryPairValidationError,
} from "@open-inspect/shared/types/repositories";
import {
  createRouteSourceControlProvider,
  error,
  json,
  resolveRepoOrError,
  type RequestContext,
  GITHUB_USER_OR_SERVICE_ROUTE,
  requirePermission,
  type ServiceActorClaimsResult,
} from "./shared";
import { pinnableSubscriptionSlots } from "./fork-subscription-slots";

const logger = createLogger("router:session-create");
const INVALID_SESSION_REQUEST_BODY_ERROR = "Invalid session request body";

// Defense in depth on top of schema validation — matches git ref charsets.
const BRANCH_NAME_PATTERN = /^[\w.\-/]+$/;

/** The only create body the healthcheck service may send: at most a string title. */
function isHealthcheckCreateBody(raw: Record<string, unknown>): boolean {
  return Object.entries(raw).every(([key, value]) => key === "title" && typeof value === "string");
}

function withRetryAfter(response: Response): Response {
  response.headers.set("Retry-After", String(EXTERNAL_REF_RETRY_AFTER_SECONDS));
  return response;
}

function externalRefInProgress(): Response {
  return withRetryAfter(json({ error: "Conflict", code: "external_ref_in_progress" }, 409));
}

/** The most rounds a retry spends releasing a dead first attempt before giving up. */
const EXTERNAL_REF_REPLAY_ROUNDS = 2;

/**
 * Statuses a holder at status revision 0 can carry without its runtime having
 * claimed the row: `created` (init pending or lost), `failed` (init reported
 * failed, possibly after it committed) and `archived` (the draft sweep retired
 * a row whose runtime answered 404). Whether a runtime exists decides.
 */
const UNCLAIMED_HOLDER_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "created",
  "failed",
  "archived",
]);

/**
 * Answer a create whose external ref a session already holds: the original
 * session, a retryable or fatal conflict, or `null` to create afresh (no
 * holder, or a dead first attempt was released). `afterConflict` is set when
 * this request just lost the ref's unique index to another attempt.
 *
 * A holder the runtime never claimed is probed first: a dead attempt frees its
 * ref whatever body the retry sends, so a corrected create can reuse the ref.
 */
async function replayExternalRef(
  env: Env,
  ctx: RequestContext,
  ref: SessionExternalRef,
  ownerUserId: string,
  afterConflict: boolean
): Promise<Response | null> {
  const store = new SessionIndexStore(ctx.db);
  for (let round = 0; round < EXTERNAL_REF_REPLAY_ROUNDS; round++) {
    const holder = await store.findByExternalRef(ref.service, ref.ref);
    if (!holder) return afterConflict ? externalRefInProgress() : null;
    // Never reveal anything about another person's session.
    if (holder.userId !== ownerUserId) {
      return json({ error: "Conflict", code: "external_ref_conflict" }, 409);
    }
    const replayed = (status: SessionStatus = holder.status): Response => {
      if (holder.fingerprint !== ref.fingerprint) {
        return json({ error: "Conflict", code: "external_ref_payload_mismatch" }, 409);
      }
      const result: CreateSessionResponse = { sessionId: holder.id, status, replayed: true };
      return json(result, 200);
    };
    if (holder.statusRevision > 0 || !UNCLAIMED_HOLDER_STATUSES.has(holder.status)) {
      return replayed();
    }

    const runtime = await probeSessionRuntime(env, ctx, holder.id);
    if (runtime === "unknown") {
      return withRetryAfter(
        json({ error: "Service Unavailable", code: "external_ref_indeterminate" }, 503)
      );
    }
    if (runtime === "exists") {
      // The init committed but its answer was lost, so the row was marked failed.
      if (holder.status === "failed" && (await store.restoreInitializedSession(holder.id))) {
        return replayed("created");
      }
      return replayed();
    }
    if (
      holder.status === "created" &&
      Date.now() - holder.createdAt < EXTERNAL_REF_PENDING_LEASE_MS
    ) {
      return externalRefInProgress();
    }
    if (await store.releaseExternalRef(holder.id)) {
      logger.info("External ref released from a dead first attempt", {
        event: "external_ref.released",
        session_id: holder.id,
        holder_status: holder.status,
        service: ref.service,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return null;
    }
  }
  return externalRefInProgress();
}

async function extractSessionActorProfileClaims(
  request: Request,
  ctx: RequestContext
): Promise<ServiceActorClaimsResult> {
  const parsed = await parseCreateSessionInput(request);
  if (!parsed.ok) return { kind: "rejected", response: error(parsed.message, 400) };

  // Keep the admission-time claim view aligned with the handler's raw-body
  // identity guard; the same rejection ends admission before enrollment.
  const enforcement = applyIdentityEnforcement(ctx, "session-create", parsed.raw);
  if (enforcement.rejection) return { kind: "rejected", response: enforcement.rejection };

  return {
    kind: "claims",
    claims: {
      displayName: parsed.input.actorDisplayName,
      email: parsed.input.actorEmail,
      avatarUrl: parsed.input.actorAvatarUrl,
    },
  };
}

export async function handleCreateSession(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const parsed = await parseCreateSessionInput(request);
  if (!parsed.ok) return error(parsed.message, 400);
  const body = parsed.input;

  // The sandbox canary only proves a sandbox spawns and connects: a title, no
  // repository, environment, skills or provider choice.
  if (
    ctx.principal?.kind === "service" &&
    ctx.principal.service === "healthcheck" &&
    !isHealthcheckCreateBody(parsed.raw)
  ) {
    return json(
      { error: "healthcheck may only create an empty session", code: "healthcheck_body_refused" },
      403
    );
  }

  // Identity comes from the verified principal; caller-asserted identity/SCM
  // body fields are rejected. SCM credentials flow only through
  // server-side enrichment from the token store.
  const enforcement = applyIdentityEnforcement(ctx, "session-create", parsed.raw);
  if (enforcement.rejection) return enforcement.rejection;
  const enforced = enforcement.enforced;

  // Admission finalized the canonical subject before RBAC. The handler may
  // consume only that exact subject; it must never perform late identity
  // selection from body profile fields.
  const resolution = requireAdmittedCanonicalUserId(ctx, enforced);
  if (resolution instanceof Response) return resolution;
  const resolvedUserId = resolution;

  let ref: SessionExternalRef | null = null;
  if (body.externalRef !== undefined) {
    if (ctx.principal?.kind !== "service" || ctx.principal.service === "web") {
      return json(
        { error: "externalRef is only accepted from a service", code: "external_ref_not_allowed" },
        400
      );
    }
    ref = {
      service: ctx.principal.service,
      ref: body.externalRef,
      fingerprint: await externalRefFingerprint(body),
    };
    // A retry answers from the first attempt before any target or SCM work.
    const replay = await replayExternalRef(env, ctx, ref, resolvedUserId, false);
    if (replay) return replay;
  }

  const outcome = await createNewSession(request, env, ctx, {
    body,
    resolvedUserId,
    participantUserId: enforced.participantUserId,
    spawnSource: enforced.spawnSource ?? undefined,
    externalRef: ref,
  });
  if (outcome instanceof Response) return outcome;
  if (outcome.kind === "init_failed") {
    if (outcome.cause instanceof SessionExternalRefTakenError && ref) {
      // A concurrent attempt with the same ref won the unique index.
      return (
        (await replayExternalRef(env, ctx, ref, resolvedUserId, true)) ?? externalRefInProgress()
      );
    }
    return error("Failed to create session", 500);
  }

  const result: CreateSessionResponse = {
    sessionId: outcome.sessionId,
    status: "created",
    ...(ref ? { replayed: false } : {}),
  };

  return json(result, 201);
}

/** Everything a new root session needs beyond its validated create body. */
export interface NewSessionSpec {
  body: CreateSessionInput;
  /** The admitted canonical user; owns the session. */
  resolvedUserId: string;
  participantUserId: string;
  spawnSource: SpawnSource | undefined;
  externalRef: SessionExternalRef | null;
  fork?: SessionForkOrigin | null;
  /** A pool slot of the bound home to try first; refused unless the home has spent it. */
  preferredSubscriptionSlot?: string | null;
}

export type NewSessionOutcome =
  | { kind: "created"; sessionId: string }
  /** The index row may exist (marked failed); `cause` says why init threw. */
  | { kind: "init_failed"; sessionId: string; cause: unknown };

/**
 * Create a root session for an admitted user: target authorization, SCM
 * enrichment, provider auth, admission, skills, memory, and initialization.
 * Shared by `POST /sessions` and forks so both resolve these the same way.
 * A Response is a refusal; nothing was created.
 */
export async function createNewSession(
  request: Request,
  env: Env,
  ctx: RequestContext,
  spec: NewSessionSpec
): Promise<Response | NewSessionOutcome> {
  const { body, resolvedUserId } = spec;
  let repositoryContext: RepositoryPair | null;
  try {
    repositoryContext = normalizeOptionalRepositoryPair(body, INVALID_SESSION_REQUEST_BODY_ERROR);
  } catch (e) {
    if (e instanceof RepositoryPairValidationError) {
      return error(e.message, 400);
    }
    throw e;
  }

  const targetAuthorizationError = await authorizeSessionTarget(ctx, {
    teamId: null,
    environmentId: body.environmentId,
    repositories: (body.repositories ?? (repositoryContext ? [repositoryContext] : [])).map(
      (repository) => ({ owner: repository.repoOwner, name: repository.repoName })
    ),
  });
  if (targetAuthorizationError) return targetAuthorizationError;
  if (body.environmentId) {
    const environmentError = await authorizeEnvironmentTarget(ctx, {
      environmentId: body.environmentId,
      ownerTeamId: body.teamId ?? null,
    });
    if (environmentError) return environmentError;
  }

  // Validate branch names if provided (defense in depth)
  if (body.branch && !BRANCH_NAME_PATTERN.test(body.branch)) {
    return error("Invalid branch name");
  }
  for (const entry of body.repositories ?? []) {
    if (entry.baseBranch && !BRANCH_NAME_PATTERN.test(entry.baseBranch)) {
      return error(`Invalid branch name for ${entry.repoOwner}/${entry.repoName}`);
    }
  }

  let repoId: number | null = null;
  let defaultBranch: string | null = null;
  let repoOwner: string | null = null;
  let repoName: string | null = null;
  let repositories: RepositoryRef[] | undefined;
  let environmentId: string | null = null;
  // Environment and ad-hoc list modes both produce a resolved member list;
  // scalar mode stays a single lookup. The three are mutually exclusive by
  // schema (hasExclusiveSessionTarget).
  if (body.environmentId) {
    // Snapshot the environment's members and resolve them like any other list
    // (design §7.6); environment_id records provenance on the session.
    const envInputs = await resolveEnvironmentTarget(
      new EnvironmentStore(ctx.db),
      body.environmentId
    );
    repositories = await resolveSessionRepositories(env, envInputs, ctx, logger);
    environmentId = body.environmentId;
  } else if (body.repositories) {
    repositories = await resolveSessionRepositories(env, body.repositories, ctx, logger);
  }

  if (repositories) {
    // The primary entry is mirrored into the scalar columns so filters,
    // settings resolution, and pre-list consumers keep working unchanged.
    const primary = repositories[0];
    repoOwner = primary.repoOwner;
    repoName = primary.repoName;
    repoId = primary.repoId;
    defaultBranch = primary.baseBranch;
  } else if (repositoryContext) {
    repoOwner = repositoryContext.repoOwner;
    repoName = repositoryContext.repoName;
    const resolved = await resolveRepoOrError(env, repoOwner, repoName, ctx, logger);

    repoId = resolved.repoId;
    defaultBranch = resolved.defaultBranch;
  }

  const { participantUserId, spawnSource } = spec;

  const userStore = new UserStore(ctx.db);
  // The trigger actor is the admitted user (web login, Teams sender, GitHub
  // sender); only bots name a trigger kind or a work-item author.
  const trigger = await resolveSessionTrigger(ctx, userStore, body);
  if (trigger instanceof Response) return trigger;
  const teamId = body.teamId ?? null;
  const team = await resolveCreationOwnerTeam(ctx, teamId);
  if (team instanceof Response) return team;
  if (teamId) {
    if (
      !resolvedUserId ||
      !(await new TeamMembershipStore(ctx.db).listForUser(resolvedUserId)).has(teamId)
    ) {
      return json({ error: "Not a team member", code: "not_member" }, 403);
    }
  }
  const resolvedTargetAuthorizationError = await authorizeSessionTarget(ctx, {
    teamId,
    environmentId,
    repositories: (
      repositories ?? (repoOwner && repoName ? [{ repoOwner, repoName, repoId }] : [])
    ).map((repository) => ({
      owner: repository.repoOwner,
      name: repository.repoName,
      repoId: repository.repoId,
    })),
  });
  if (resolvedTargetAuthorizationError) return resolvedTargetAuthorizationError;
  const visibility = body.visibility ?? team?.defaultVisibility ?? "workspace";
  if (visibility === "team" && !teamId) return teamRequiredResponse();
  if (visibility === "private" && !resolvedUserId)
    return json({ error: "Session owner required", code: "owner_required" }, 400);

  const githubDeployment = resolveScmProviderFromEnv(env.SCM_PROVIDER) === "github";
  let scmLogin = body.scmLogin;
  let scmName = body.scmName;
  let scmEmail = body.scmEmail;
  // SCM credentials never arrive in the body; enrichment below resolves them
  // through Better Auth using the canonical user.
  let scmUserId: string | undefined;

  // Resolve linked GitHub identity and credentials through Better Auth only
  // when SCM enrichment is needed. A user without a linked GitHub account uses
  // the GitHub App fallback; account linking is intentionally deferred.
  if (githubDeployment) {
    const enrichment = await resolveGitHubEnrichmentForRequest(
      userStore,
      resolvedUserId,
      await resolveGitHubCredentialAuthority(ctx, request.headers)
    );
    if (enrichment) {
      scmUserId = enrichment.scmUserId;
      scmLogin ??= enrichment.scmLogin;
      scmName ??= enrichment.displayName;
      scmEmail ??= enrichment.email;
    }
  }

  // Validate harness, model and reasoning effort once for both DO init and D1 index
  // No harness asked for: the model's own harness, so Anthropic lands on Claude Agent.
  const model = getValidModelOrDefault(body.model);
  const harness = isValidHarness(body.harness) ? body.harness : harnessForModel(model);
  const harnessModelIncompatibility = checkHarnessCompatibility(harness, model);
  if (harnessModelIncompatibility) return error(harnessModelIncompatibility.message, 400);
  const reasoningEffort =
    body.reasoningEffort && isValidReasoningEffort(model, body.reasoningEffort)
      ? body.reasoningEffort
      : null;

  // Session-scoped integration settings resolve from the primary member (design
  // §6.2). In list mode that is repositories[0]; otherwise the scalar pair — the
  // two are the same repo by the row-0-mirrors-scalars invariant. Launching
  // from a saved environment layers its overrides on top (design §13.5).
  const scopeMembers =
    repositories ?? (repoOwner && repoName ? [{ repoOwner, repoName, repoId }] : []);
  const { codeServerEnabled, vncEnabled, sandboxSettings } = await resolveSessionScopedSettings(
    ctx.db,
    scopeMembers,
    environmentId
  );

  const sessionId = generateId();
  let providerAuth;
  try {
    providerAuth = await resolveSessionProviderAuth(ctx.db, {
      explicit: body.providerSelections,
      actorUserId: resolvedUserId,
      unattended: spawnSource !== undefined && spawnSource !== "user",
      harness,
    });
  } catch (e) {
    if (e instanceof ProviderAccountSelectionPolicyError) return error(e.message, e.status);
    throw e;
  }
  const admission = await admitNewSession({
    db: ctx.db,
    requestId: ctx.request_id,
    actorUserId: resolvedUserId,
    model,
    triggerKind: trigger.triggerKind,
    harness,
    providerAuth,
    repoPrivate: () => repositoriesArePrivate(createRouteSourceControlProvider(env), scopeMembers),
    workItemAuthorUserId: trigger.workItemAuthorUserId,
  });
  if (admission.kind === "refused") return newSessionRefusalResponse(admission.refusal);
  const preferredSubscriptionSlot = spec.preferredSubscriptionSlot ?? null;
  if (
    preferredSubscriptionSlot !== null &&
    !(await pinnableSubscriptionSlots(ctx.db, harness, admission.authHomeId)).some(
      ({ slot }) => slot === preferredSubscriptionSlot
    )
  ) {
    return json(
      { error: "Subscription slot unavailable", code: SUBSCRIPTION_SLOT_UNAVAILABLE },
      400
    );
  }

  let managedSkillsManifest;
  try {
    managedSkillsManifest = await resolveManagedSkills(
      ctx.db,
      {
        repositories: scopeMembers,
        environmentId,
      },
      body.skillSelection ?? { mode: "all" },
      resolvedUserId
    );
  } catch (e) {
    if (e instanceof SkillResolutionError) return error(e.message, e.status);
    throw e;
  }

  const memorySelection = await createSessionMemorySelector(ctx).select({
    principal: { userId: resolvedUserId, ownerTeamId: teamId },
    repositories: scopeMembers,
    environmentId,
    includePersonalMemories: body.includePersonalMemories,
  });

  const input: SessionInitInput = {
    memory: resolvedPin(memorySelection),
    ownerTeamId: teamId,
    visibility: admission.visibility(visibility),
    sessionId,
    repoOwner,
    repoName,
    repoId,
    defaultBranch,
    branch: body.branch,
    repositories,
    environmentId,
    title: body.title,
    harness,
    model,
    reasoningEffort,
    participantUserId,
    platformUserId: resolvedUserId,
    participantCanonicalUserId: resolvedUserId,
    scmLogin,
    scmName,
    scmEmail,
    scmUserId,
    codeServerEnabled,
    vncEnabled,
    sandboxSettings,
    spawnSource,
    managedSkills: resolvedPin(managedSkillsManifest),
    providerAuth: admission.providerAuth,
    triggerActorUserId: resolvedUserId,
    triggerKind: trigger.triggerKind,
    workItemAuthorUserId: trigger.workItemAuthorUserId,
    authHomeId: admission.authHomeId,
    authHomeSelection: admission.authHomeSelection,
    externalRef: spec.externalRef,
    fork: spec.fork ?? null,
    preferredSubscriptionSlot,
  };

  try {
    await initializeSession(env, input, ctx);
  } catch (cause) {
    logger.error("Failed to initialize session", {
      error: cause instanceof Error ? cause.message : String(cause),
      session_id: sessionId,
      trace_id: ctx.trace_id,
    });
    return { kind: "init_failed", sessionId, cause };
  }
  await admission.recordCreated(sessionId);
  return { kind: "created", sessionId };
}

export const sessionCreateRoutes = new Hono<ControlPlaneHonoEnv>();

sessionCreateRoutes.post(
  "/sessions",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("sessions.create", {
      optInServices: ["motion", "healthcheck"],
    }),
    serviceActorClaims: extractSessionActorProfileClaims,
  }),
  (c) => dispatch(c, handleCreateSession)
);
