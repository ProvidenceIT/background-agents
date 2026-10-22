import { Hono } from "hono";
import { isValidModel, VALID_MODELS } from "@open-inspect/shared/models";
import {
  createSessionInputSchema,
  forkSessionRequestSchema,
  type ForkHandoffResponse,
  type ForkSessionResponse,
} from "@open-inspect/shared/types/session-api";
import { sessionSnapshotSchema } from "@open-inspect/shared/types/server-messages";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  applyIdentityEnforcement,
  requireAdmittedCanonicalUserId,
} from "../routing/identity-enforcement";
import { turnTriggerKind } from "../auth-homes/turn-admission";
import {
  SessionForkTakenError,
  SessionIndexStore,
  type SessionForkHolder,
  type SessionForkOrigin,
} from "../db/session-index";
import { createLogger } from "../logger";
import { sessionMessagePageSchema, SessionInternalPaths } from "../session/contracts";
import type { EnqueuePromptRequest } from "../session/enqueue-prompt-contract";
import { buildForkHandoff, forkStartBranch, type ForkHandoffSource } from "../session/fork-handoff";
import type { Env } from "../types";
import { parseBody } from "./body";
import { createNewSession } from "./session-create";
import { type SessionRouteContext, dispatchSession } from "./session-route";
import {
  error,
  GITHUB_USER_OR_SERVICE_ROUTE,
  json,
  permissionRequirement,
  requireAll,
  requireSession,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  sessionRequirement,
} from "./shared";

const logger = createLogger("router:session-fork");

/** The newest prompts the handoff reads; one runtime page. */
const HANDOFF_PROMPT_PAGE_SIZE = 100;
const UNTITLED_SESSION = "Untitled session";

interface ForkSource {
  handoff: ForkHandoffSource;
  harness: string;
  model: string | undefined;
  reasoningEffort: string | undefined;
}

async function readForkSource(
  ctx: SessionRouteContext,
  sessionId: string
): Promise<ForkSource | Response> {
  const snapshotResponse = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.snapshot);
  if (snapshotResponse.status === 404) return error("Session not found", 404);
  if (!snapshotResponse.ok) return error("Session snapshot unavailable", 502);
  const snapshot = sessionSnapshotSchema.safeParse(await snapshotResponse.json().catch(() => null));
  if (!snapshot.success) return error("Invalid session snapshot", 502);

  const messagesResponse = await ctx.sessionRuntime.fetch(
    sessionId,
    SessionInternalPaths.messages,
    undefined,
    `?limit=${HANDOFF_PROMPT_PAGE_SIZE}`
  );
  if (!messagesResponse.ok) return error("Session messages unavailable", 502);
  const page = sessionMessagePageSchema.safeParse(await messagesResponse.json().catch(() => null));
  if (!page.success) return error("Invalid session messages", 502);

  const session = snapshot.data.session;
  const repositories =
    session.repositories && session.repositories.length > 0
      ? session.repositories
      : session.repoOwner && session.repoName && session.baseBranch
        ? [
            {
              repoOwner: session.repoOwner,
              repoName: session.repoName,
              baseBranch: session.baseBranch,
              branchName: session.branchName,
            },
          ]
        : [];
  return {
    handoff: {
      sessionId,
      title: session.title,
      repositories: repositories.map(({ repoOwner, repoName, baseBranch, branchName }) => ({
        repoOwner,
        repoName,
        baseBranch,
        branchName,
      })),
      lastTurnLimit: session.lastTurnLimit ?? null,
      events: snapshot.data.timeline.events.map((item) => item.event),
      planEvents: snapshot.data.timeline.planEvents?.map((item) => item.event),
      // The runtime pages newest first.
      prompts: page.data.messages.map((message) => message.content).reverse(),
      promptsTruncated: page.data.hasMore,
    },
    harness: session.harness,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
  };
}

async function handleForkHandoff(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const source = await readForkSource(ctx, params.id);
  if (source instanceof Response) return source;
  return json({ handoff: buildForkHandoff(source.handoff) } satisfies ForkHandoffResponse);
}

function forkResponse(sessionId: string, sourceId: string, created: boolean): Response {
  const body: ForkSessionResponse = { sessionId, forkedFromSessionId: sourceId, created };
  return json(body, created ? 201 : 200);
}

/**
 * Answer a fork request whose id a fork already holds: that fork, a conflict
 * when another person holds it, or null to create afresh after releasing a
 * fork that failed before its runtime claimed it.
 */
async function replayFork(
  store: SessionIndexStore,
  origin: SessionForkOrigin,
  holder: SessionForkHolder | null,
  ownerUserId: string
): Promise<Response | null> {
  if (!holder) return null;
  // Never reveal anything about another person's fork.
  if (holder.userId !== ownerUserId) {
    return json({ error: "Conflict", code: "fork_request_conflict" }, 409);
  }
  if (
    holder.status === "failed" &&
    holder.statusRevision === 0 &&
    (await store.releaseFailedFork(holder.id))
  ) {
    return null;
  }
  return forkResponse(holder.id, origin.sourceSessionId, false);
}

async function handleForkSession(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const sourceId = params.id;
  const body = await parseBody(request, forkSessionRequestSchema);
  if (body instanceof Response) return body;

  const enforcement = applyIdentityEnforcement(ctx, "session-create", {});
  if (enforcement.rejection) return enforcement.rejection;
  const resolvedUserId = requireAdmittedCanonicalUserId(ctx, enforcement.enforced);
  if (resolvedUserId instanceof Response) return resolvedUserId;

  const store = new SessionIndexStore(ctx.db);
  const origin: SessionForkOrigin = {
    sourceSessionId: sourceId,
    forkRequestId: body.forkRequestId,
  };
  const replay = await replayFork(store, origin, await store.findFork(origin), resolvedUserId);
  if (replay) return replay;

  if (body.model !== undefined && !isValidModel(body.model)) {
    return error(`Invalid model "${body.model}". Valid models: ${VALID_MODELS.join(", ")}`, 400);
  }

  const source = await readForkSource(ctx, sourceId);
  if (source instanceof Response) return source;
  const sourceTitle = source.handoff.title?.trim() || UNTITLED_SESSION;
  const repositories = source.handoff.repositories.map((repository) => ({
    repoOwner: repository.repoOwner,
    repoName: repository.repoName,
    baseBranch: forkStartBranch(repository),
  }));
  const createBody = createSessionInputSchema.safeParse({
    title: body.title ?? `${sourceTitle} (fork)`,
    visibility: "private",
    harness: body.harness ?? source.harness,
    model: body.model ?? source.model,
    reasoningEffort: body.reasoningEffort ?? source.reasoningEffort,
    ...(repositories.length > 0 ? { repositories } : {}),
  });
  if (!createBody.success) return error("Source session cannot be forked", 409);
  const handoff = body.handoff ?? buildForkHandoff(source.handoff);

  const outcome = await createNewSession(request, env, ctx, {
    body: createBody.data,
    resolvedUserId,
    participantUserId: enforcement.enforced.participantUserId,
    spawnSource: undefined,
    externalRef: null,
    fork: origin,
  });
  if (outcome instanceof Response) return outcome;
  if (outcome.kind === "init_failed") {
    if (outcome.cause instanceof SessionForkTakenError) {
      // A concurrent request with the same fork id won the unique index.
      const raced = await replayFork(store, origin, await store.findFork(origin), resolvedUserId);
      if (raced) return raced;
    }
    return error("Failed to create fork", 500);
  }

  const forkId = outcome.sessionId;
  const promptRequest = {
    turn: {
      triggerKind: turnTriggerKind(ctx.principal),
      channel: "prompt",
      requestId: ctx.request_id,
    },
    content: handoff,
    authorId: enforcement.enforced.participantUserId,
    canonicalUserId: resolvedUserId,
    source: "web",
  } satisfies EnqueuePromptRequest;
  let promptResponse: Response;
  try {
    promptResponse = await ctx.sessionRuntime.fetch(forkId, SessionInternalPaths.prompt, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(promptRequest),
    });
  } catch (cause) {
    logger.error("Failed to enqueue the fork's first prompt", {
      event: "session.fork_prompt_enqueue_failed",
      source_id: sourceId,
      fork_id: forkId,
      error: cause instanceof Error ? cause.message : String(cause),
      trace_id: ctx.trace_id,
      request_id: ctx.request_id,
    });
    await store.updateStatus(forkId, "failed");
    return error("Failed to enqueue the fork's first prompt", 500);
  }
  if (!promptResponse.ok) {
    logger.warn("Fork's first prompt was refused", {
      event: "session.fork_prompt_refused",
      source_id: sourceId,
      fork_id: forkId,
      prompt_status: promptResponse.status,
      trace_id: ctx.trace_id,
      request_id: ctx.request_id,
    });
    await store.updateStatus(forkId, "failed");
    // The runtime's refusal (quota, auth home) is the caller's answer.
    return promptResponse;
  }

  logger.info("Forked session", {
    event: "session.fork",
    source_id: sourceId,
    fork_id: forkId,
    handoff_edited: body.handoff !== undefined,
    trace_id: ctx.trace_id,
    request_id: ctx.request_id,
  });
  return forkResponse(forkId, sourceId, true);
}

export const sessionForkRoutes = new Hono<ControlPlaneHonoEnv>();

sessionForkRoutes.get(
  "/sessions/:id/fork/handoff",
  admit({
    ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    authorization: requireSession("read"),
    cacheControl: "private, no-store",
  }),
  (c) => dispatchSession(c, handleForkHandoff)
);

sessionForkRoutes.post(
  "/sessions/:id/fork",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requireAll(
      sessionRequirement("read"),
      sessionRequirement("collaborate"),
      permissionRequirement("sessions.create")
    ),
  }),
  (c) => dispatchSession(c, handleForkSession)
);
