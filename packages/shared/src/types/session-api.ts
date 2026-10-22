import { harnessIdSchema } from "../harnesses";
import { z } from "zod";
import { sessionSkillSelectionSchema } from "./skills";
import type { AgentResponse } from "./artifacts";
import { sessionRepositoriesInputSchema } from "./repositories";
import { subscriptionSlotSchema, type EventResponse } from "./sandbox-events";
import { MAX_SESSION_SUBSCRIPTION_SLOTS } from "./session-subscription";
import { MAX_WEB_PROMPT_CHARS, promptContentSchema } from "./prompts";
import { modelProviderSelectionsSchema } from "./provider-accounts";
import { triggerKindSchema } from "./auth-homes";
import { sessionVisibilitySchema } from "./teams";
import {
  messageSourceSchema,
  sessionStatusSchema,
  type SandboxStatus,
  type SessionListResponse,
  type SessionStatus,
} from "./sessions";

export const userPreferencesSchema = z.object({
  userId: z.string(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  branch: z.string().optional(),
  updatedAt: z.number(),
});

export type UserPreferences = z.infer<typeof userPreferencesSchema>;

const nonEmptyStringSchema = z.string().trim().min(1);

/**
 * A service's idempotency key: `externalRef` on POST /sessions and
 * `clientRequestId` on POST /sessions/:id/prompt. 1-200 characters, starting
 * with a letter or digit, then letters, digits and `._:/@-`.
 */
export const SESSION_EXTERNAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
export const sessionExternalRefSchema = z.string().regex(SESSION_EXTERNAL_REF_PATTERN);

export const MAX_CHILD_FOLLOW_UP_PROMPT_CHARS = MAX_WEB_PROMPT_CHARS;

export const slackCallbackContextSchema = z.object({
  source: z.literal("slack"),
  channel: z.string(),
  threadTs: z.string(),
  repoFullName: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
  reactionMessageTs: z.string().optional(),
  /**
   * Set when the session belongs to an automation rather than an interactive
   * request. A thread follow-up completes through the same callback as an
   * `@mention` turn, so the route alone cannot tell the two apart, and only the
   * control plane knows which automation (if any) owns the thread.
   */
  automationId: z.string().optional(),
});

export type SlackCallbackContext = z.infer<typeof slackCallbackContextSchema>;

/**
 * Domain separator for the Slack activity-refresh callback. Signed into the
 * body and required by the route, so a body minted for another callback — whose
 * signature is equally valid — cannot satisfy this one. Shared so the producer
 * and the route cannot drift apart on the literal.
 */
export const SLACK_ACTIVITY_REFRESH_KIND = "slack.activity_refresh";

const linearCallbackContextBaseSchema = z.strictObject({
  source: z.literal("linear"),
  issueId: nonEmptyStringSchema,
  issueIdentifier: nonEmptyStringSchema,
  issueUrl: nonEmptyStringSchema,
  /** External Linear team used for scoped reads; absent in persisted legacy contexts. */
  linearTeamId: nonEmptyStringSchema.optional(),
  /** Settings repository when one can be resolved for this Linear message. */
  repoFullName: nonEmptyStringSchema.optional(),
  model: nonEmptyStringSchema,
  agentSessionId: nonEmptyStringSchema.optional(),
  emitToolProgressActivities: z.boolean().optional(),
});

export const linearCallbackContextSchema = z.union([
  linearCallbackContextBaseSchema.extend({
    organizationId: nonEmptyStringSchema,
    /** Installed Linear app-user identity used to verify runtime credentials. */
    appUserId: nonEmptyStringSchema,
    /** Move the issue to its team's started workflow when this message begins processing. */
    transitionIssueOnStart: z.literal(true),
  }),
  linearCallbackContextBaseSchema.extend({
    organizationId: nonEmptyStringSchema.optional(),
    appUserId: nonEmptyStringSchema.optional(),
    transitionIssueOnStart: z.literal(false).optional(),
  }),
]);

export type LinearCallbackContext = z.infer<typeof linearCallbackContextSchema>;

export const linearStartCallbackSchema = z.strictObject({
  sessionId: nonEmptyStringSchema,
  messageId: nonEmptyStringSchema,
  timestamp: z.number().refine(Number.isFinite),
  signature: nonEmptyStringSchema,
  context: linearCallbackContextSchema,
});

export type LinearStartCallback = z.infer<typeof linearStartCallbackSchema>;

export const linearCompletionCallbackPayloadSchema = z.strictObject({
  sessionId: nonEmptyStringSchema,
  messageId: nonEmptyStringSchema,
  success: z.boolean(),
  error: z.string().optional(),
  timestamp: z.number().refine(Number.isFinite),
  context: linearCallbackContextSchema,
});

export const linearCompletionCallbackSchema = linearCompletionCallbackPayloadSchema.extend({
  signature: nonEmptyStringSchema,
});

export type LinearCompletionCallback = z.infer<typeof linearCompletionCallbackSchema>;

export const linearToolCallCallbackPayloadSchema = z.strictObject({
  sessionId: nonEmptyStringSchema,
  tool: nonEmptyStringSchema,
  args: z.record(z.string(), z.unknown()),
  callId: nonEmptyStringSchema,
  status: z.string().optional(),
  timestamp: z.number().refine(Number.isFinite),
  context: linearCallbackContextSchema,
});

export const linearToolCallCallbackSchema = linearToolCallCallbackPayloadSchema.extend({
  signature: nonEmptyStringSchema,
});

export type LinearToolCallCallback = z.infer<typeof linearToolCallCallbackSchema>;

/**
 * Where a Teams bot renders a turn's progress and completion: the Bot
 * Framework conversation and service URL it posts to, and the activity it
 * edits. `channelId` is the Teams channel (the binding's external id) when
 * the conversation is a channel thread; group and personal chats have none.
 */
export const msteamsCallbackContextSchema = z.object({
  source: z.literal("msteams"),
  conversationId: nonEmptyStringSchema,
  serviceUrl: nonEmptyStringSchema,
  replyToId: nonEmptyStringSchema.optional(),
  channelId: nonEmptyStringSchema.optional(),
  repoFullName: nonEmptyStringSchema.optional(),
  model: nonEmptyStringSchema,
});

export type MsTeamsCallbackContext = z.infer<typeof msteamsCallbackContextSchema>;

export const automationCallbackContextSchema = z.object({
  source: z.literal("automation"),
  automationId: z.string(),
  runId: z.string(),
  automationName: z.string(),
});

export type AutomationCallbackContext = z.infer<typeof automationCallbackContextSchema>;

export const callbackContextSchema = z.union([
  slackCallbackContextSchema,
  linearCallbackContextSchema,
  msteamsCallbackContextSchema,
  automationCallbackContextSchema,
]);

export type CallbackContext = z.infer<typeof callbackContextSchema>;

export const sendPromptRequestSchema = z
  .object({
    content: promptContentSchema,
    source: messageSourceSchema.optional(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    attachments: z.unknown().optional(),
    callbackContext: z.unknown().optional(),
    /**
     * What a bot relays this turn as (`mention`, `issue_label`, `pr_event`);
     * the subscription-home kind gates read it. Refused from a person.
     */
    triggerKind: triggerKindSchema.optional(),
    /**
     * A service's retry key for this prompt, unique per session and service:
     * a retry with the same key and body returns the original message. Refused
     * from a person and from the web service.
     */
    clientRequestId: sessionExternalRefSchema.optional(),
  })
  .refine(
    (prompt) =>
      prompt.content.trim().length > 0 ||
      (Array.isArray(prompt.attachments) && prompt.attachments.length > 0),
    {
      message: "Prompt content must not be blank without attachments",
      path: ["content"],
    }
  );

export type SendPromptRequest = z.infer<typeof sendPromptRequestSchema>;

export const sessionBudgetUpdateSchema = z.strictObject({
  maxCostUsd: z.number().finite().positive().nullable(),
});

export type SessionBudgetUpdate = z.infer<typeof sessionBudgetUpdateSchema>;

/** Request body for POST /sessions/:parentId/children/:childId/prompt. */
export const childFollowUpPromptRequestSchema = z.strictObject({
  content: z
    .string()
    .min(1)
    .max(MAX_CHILD_FOLLOW_UP_PROMPT_CHARS)
    .refine((content) => content.trim().length > 0, { message: "content must not be blank" }),
});

export type ChildFollowUpPromptRequest = z.infer<typeof childFollowUpPromptRequestSchema>;

function hasRepositoryIdentifier(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

interface CreateSessionRepositoryFields {
  repoOwner?: string | null;
  repoName?: string | null;
  branch?: string;
}

function hasMatchingRepositoryIdentifiers(data: CreateSessionRepositoryFields): boolean {
  return hasRepositoryIdentifier(data.repoOwner) === hasRepositoryIdentifier(data.repoName);
}

function hasRepositoryForBranch(data: CreateSessionRepositoryFields): boolean {
  return hasRepositoryIdentifier(data.repoOwner) || !data.branch?.trim();
}

function hasScalarRepositoryTarget(data: CreateSessionRepositoryFields): boolean {
  return (
    hasRepositoryIdentifier(data.repoOwner) ||
    hasRepositoryIdentifier(data.repoName) ||
    Boolean(data.branch?.trim())
  );
}

function hasExclusiveSessionTarget(
  data: CreateSessionRepositoryFields & {
    repositories?: unknown[] | null;
    environmentId?: string | null;
  }
): boolean {
  // At most one target mode may be selected: a named environment
  // (environmentId), an ad-hoc repository list (repositories), or the scalar
  // repoOwner/repoName/branch form. Presence-based, not length-based: any
  // provided array selects the list mode (sessionRepositoriesInputSchema
  // separately rejects empty lists, so [] can never smuggle another mode
  // through).
  const activeModes = [
    Boolean(data.repositories),
    hasRepositoryIdentifier(data.environmentId),
    hasScalarRepositoryTarget(data),
  ].filter(Boolean).length;
  return activeModes <= 1;
}

const createSessionRequestBaseSchema = z.object({
  teamId: z.string().min(1).nullable().optional(),
  visibility: sessionVisibilitySchema.optional(),
  repoOwner: z.string().trim().min(1).nullish(),
  repoName: z.string().trim().min(1).nullish(),
  title: z.string().optional(),
  /** Agent harness; fixed at create like base_branch. Omission means the built-in harness. */
  harness: harnessIdSchema.optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  branch: z.string().optional(),
  /**
   * Ordered repository list ([0] = primary). Mutually exclusive with the
   * scalar repoOwner/repoName/branch fields and environmentId.
   */
  repositories: sessionRepositoriesInputSchema.optional(),
  /**
   * Launch from a named environment: its snapshotted repositories become the
   * session's repository list and sessions.environment_id records provenance
   * (design §5.5/§7.6). Mutually exclusive with repositories and the scalar
   * fields.
   */
  environmentId: z.string().trim().min(1).nullish(),
  /** Managed skills are resolved and pinned when the session is created. */
  skillSelection: sessionSkillSelectionSchema.optional(),
  includePersonalMemories: z.boolean().optional(),
  /** Explicit account/API-key choices. Omission resolves provider policy. */
  providerSelections: modelProviderSelectionsSchema.optional(),
});

export const createSessionRequestSchema = createSessionRequestBaseSchema
  .refine(hasMatchingRepositoryIdentifiers, {
    message: "repoOwner and repoName must be provided together",
    path: ["repoName"],
  })
  .refine(hasRepositoryForBranch, {
    message: "branch requires repoOwner and repoName",
    path: ["branch"],
  })
  .refine(hasExclusiveSessionTarget, {
    message: "environmentId, repositories, and repoOwner/repoName/branch are mutually exclusive",
    path: ["repositories"],
  });

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const createSessionInputSchema = createSessionRequestBaseSchema
  .extend({
    // Profile fields accompany the identity asserted by a verified principal;
    // callers may not assert provider/user IDs or SCM credentials. The
    // control plane treats actorEmail as identity-bearing only when an
    // email-attesting Slack/Linear service signs this exact request body.
    scmLogin: z.string().optional(),
    scmName: z.string().optional(),
    scmEmail: z.string().optional(),
    actorDisplayName: z.string().optional(),
    actorEmail: z.string().optional(),
    actorAvatarUrl: z.string().optional(),
    /**
     * What started the session; set by the bots and the scheduler, defaulted
     * to `prompt` for a human. The public request schema strips it, and the
     * route rejects it from a human principal.
     */
    triggerKind: triggerKindSchema.optional(),
    /**
     * The SCM user id (GitHub `issue.user.id` / `pull_request.user.id`) of the
     * work item a bot is acting on, audited as `work_item_author_user_id` once
     * resolved to a workspace user. Never the actor: that is `sender.id`.
     */
    workItemAuthorScmUserId: z.string().trim().min(1).max(64).optional(),
    /**
     * A service's idempotency key for this create, unique per calling service:
     * a retry with the same key and body returns the original session. The
     * public request schema strips it, and the route rejects it from a person.
     */
    externalRef: sessionExternalRefSchema.optional(),
  })
  .refine(hasMatchingRepositoryIdentifiers, {
    message: "repoOwner and repoName must be provided together",
    path: ["repoName"],
  })
  .refine(hasRepositoryForBranch, {
    message: "branch requires repoOwner and repoName",
    path: ["branch"],
  })
  .refine(hasExclusiveSessionTarget, {
    message: "environmentId, repositories, and repoOwner/repoName/branch are mutually exclusive",
    path: ["repositories"],
  });

export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;

export const createMediaArtifactRequestSchema = z.object({
  artifactId: z.string(),
  artifactType: z.string(),
  objectKey: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type CreateMediaArtifactRequest = z.infer<typeof createMediaArtifactRequestSchema>;

export const createSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  status: sessionStatusSchema,
  /** Present when the request carried an `externalRef`: true when it returned an earlier session. */
  replayed: z.boolean().optional(),
});

export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

export const sendPromptResponseSchema = z.object({
  messageId: z.string().min(1),
  status: z.literal("queued").optional(),
  /** Present when the request carried a `clientRequestId`: true when it returned an earlier message. */
  replayed: z.boolean().optional(),
});

export type SendPromptResponse = z.infer<typeof sendPromptResponseSchema>;

/** @deprecated Import SessionListResponse from ./sessions. */
export type ListSessionsResponse = SessionListResponse;

/** Request body for POST /sessions/:parentId/children. */
export const spawnChildSessionRequestSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
});

export type SpawnChildSessionRequest = z.infer<typeof spawnChildSessionRequestSchema>;

/** Request body for POST /sessions/:parentId/children/:childId/cancel. */
export const cancelChildSessionRequestSchema = z.object({
  cancelNested: z.boolean().optional(),
});

export type CancelChildSessionRequest = z.infer<typeof cancelChildSessionRequestSchema>;

/** Returned by the child Durable Object's GET /internal/child-summary. */
export interface ChildSessionFinalResponse extends AgentResponse {
  messageId: string;
  completedAt: number | null;
  eventCount: number;
  eventLimitReached: boolean;
}

export interface ChildSessionTrajectory {
  events: EventResponse[];
  hasMore: boolean;
  cursor?: string;
  limit: number;
}

export interface ChildSessionDetail {
  session: {
    id: string;
    title: string;
    status: SessionStatus;
    repoOwner: string | null;
    repoName: string | null;
    branchName: string | null;
    model: string;
    createdAt: number;
    updatedAt: number;
  };
  sandbox: { status: SandboxStatus } | null;
  hasUnfinishedPrompt?: boolean;
  artifacts: Array<{ type: string; url: string; metadata: unknown }>;
  recentEvents: Array<{ type: string; data: unknown; createdAt: number }>;
  finalResponse?: ChildSessionFinalResponse | null;
  trajectory?: ChildSessionTrajectory;
}

/** Upper bound on the handoff draft the server builds for a fork. */
export const FORK_HANDOFF_MAX_CHARS = 40_000;

/** Client-chosen idempotency key for POST /sessions/:id/fork, unique per source session. */
export const forkRequestIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/);

/**
 * Request body for POST /sessions/:id/fork. Omitted harness/model/reasoningEffort
 * default to the source session's; an omitted handoff is built by the server.
 */
export const forkSessionRequestSchema = z.strictObject({
  forkRequestId: forkRequestIdSchema,
  handoff: promptContentSchema
    .refine((value) => value.trim().length > 0, { message: "handoff must not be blank" })
    .optional(),
  harness: harnessIdSchema.optional(),
  model: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  /**
   * The pool slot the fork prefers (`claude-3`). Absent or null picks the slot
   * with the most headroom, as every session does. Must be one of the slots
   * GET /sessions/:id/fork/subscription-slots lists for the fork's harness.
   */
  subscriptionSlot: subscriptionSlotSchema.nullable().optional(),
});
export type ForkSessionRequest = z.infer<typeof forkSessionRequestSchema>;

/** `created` is false when the forkRequestId replayed an earlier fork of the same source. */
export const forkSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  forkedFromSessionId: z.string().min(1),
  created: z.boolean(),
});
export type ForkSessionResponse = z.infer<typeof forkSessionResponseSchema>;

/** Response of GET /sessions/:id/fork/handoff: at most FORK_HANDOFF_MAX_CHARS. */
export const forkHandoffResponseSchema = z.object({
  handoff: z.string().max(FORK_HANDOFF_MAX_CHARS),
});
export type ForkHandoffResponse = z.infer<typeof forkHandoffResponseSchema>;

/**
 * One slot of the caller's subscription home a fork may prefer. `percentRemaining`
 * is the slot's tightest headroom window when the control plane knows it, else null.
 * `lastUsedAt` is when a turn on that home last settled on the slot (epoch ms).
 */
export const forkSubscriptionSlotSchema = z.strictObject({
  slot: subscriptionSlotSchema,
  percentRemaining: z.number().int().min(0).max(100).nullable(),
  lastUsedAt: z.number().int().nonnegative().nullable(),
});
export type ForkSubscriptionSlot = z.infer<typeof forkSubscriptionSlotSchema>;

/**
 * Response of GET /sessions/:id/fork/subscription-slots?harness=<id>: the slots a fork
 * on that harness may prefer, sorted by slot name. Empty when the harness has no
 * pinnable pool or the caller has no home for it; offer a choice only for two or more.
 */
export const forkSubscriptionSlotsResponseSchema = z.strictObject({
  harness: harnessIdSchema,
  slots: z.array(forkSubscriptionSlotSchema).max(MAX_SESSION_SUBSCRIPTION_SLOTS),
});
export type ForkSubscriptionSlotsResponse = z.infer<typeof forkSubscriptionSlotsResponseSchema>;

/** Error code of a fork whose subscriptionSlot is not one the caller may prefer. */
export const SUBSCRIPTION_SLOT_UNAVAILABLE = "subscription_slot_unavailable" as const;

/** How long after a limit's reset a scheduled continue fires, so the window is open. */
export const CONTINUE_AT_RESET_BUFFER_MS = 60_000;

/** The prompt a scheduled continue enqueues as the person who scheduled it. */
export const CONTINUE_AT_RESET_PROMPT = "Continue where you stopped.";

/** Error code of POST /sessions/:id/continue-at-reset when the last turn has no future reset. */
export const NO_FUTURE_RESET = "no_future_reset" as const;

/**
 * Response of POST and DELETE /sessions/:id/continue-at-reset (both take no body):
 * when the session continues on its own, or null when nothing is scheduled.
 */
export const continueAtResetResponseSchema = z.strictObject({
  scheduledContinueAtMs: z.number().int().nonnegative().nullable(),
});
export type ContinueAtResetResponse = z.infer<typeof continueAtResetResponseSchema>;
