import { z } from "zod";

/**
 * One approval system for every kind of decision a person makes for the factory.
 *
 * A request names who may answer (`responders`), what they may answer (`choices`) and what it
 * is about (`subjectRef`, plus `digest`, the revision or head SHA the request was raised for).
 * The first answer from a responder settles it: `quorum` is stored but fixed at 1. Nothing waits
 * on an answer: the handler registered for the kind starts the follow-up work.
 */

export const APPROVAL_KINDS = [
  "memory",
  "provider_account",
  "propose_fix",
  "merge",
  "readiness_override",
  "issue_publication",
  "plan",
  "session_request",
] as const;
export const approvalKindSchema = z.enum(APPROVAL_KINDS);

export const APPROVAL_DECISIONS = ["approve", "reject", "send_back"] as const;
export const approvalDecisionValueSchema = z.enum(APPROVAL_DECISIONS);

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "sent_back",
  "expired",
  "superseded",
] as const;
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);

/** The status a request settles into for each decision. */
export const APPROVAL_DECISION_STATUS = {
  approve: "approved",
  reject: "rejected",
  send_back: "sent_back",
} as const satisfies Record<ApprovalDecisionValue, ApprovalStatus>;

/** Where a person recorded a decision. */
export const APPROVAL_SURFACES = ["teams", "web", "api"] as const;
export const approvalSurfaceSchema = z.enum(APPROVAL_SURFACES);

/** Quorum is a column so a later kind can raise it; today every request settles on one answer. */
export const APPROVAL_QUORUM = 1;

/** Bounds on the serialized JSON columns, so one request cannot bloat every list read. */
export const MAX_APPROVAL_SUBJECT_REF_BYTES = 2 * 1024;
export const MAX_APPROVAL_FOLLOW_UP_BYTES = 16 * 1024;
export const MAX_APPROVAL_RESPONDER_USERS = 50;

function jsonObjectWithin(maxBytes: number) {
  return z
    .record(z.string(), z.unknown())
    .refine(
      (value) => new TextEncoder().encode(JSON.stringify(value)).length <= maxBytes,
      `must serialize to at most ${maxBytes} bytes`
    );
}

/**
 * Who may answer. A user is a responder when they are listed in `userIds`, or when `teamId` is
 * set and they are a member of that team; `role` narrows the team rule to that team role.
 * Stored requests return `userIds` sorted.
 */
export const approvalRespondersSchema = z
  .strictObject({
    userIds: z
      .array(z.string().min(1))
      .max(MAX_APPROVAL_RESPONDER_USERS)
      .refine((userIds) => new Set(userIds).size === userIds.length, "userIds must be unique"),
    teamId: z.string().min(1).nullable(),
    role: z.enum(["lead", "member"]).nullable(),
  })
  .refine((responders) => responders.userIds.length > 0 || responders.teamId !== null, {
    message: "at least one responder is required",
  })
  .refine((responders) => responders.role === null || responders.teamId !== null, {
    message: "role requires teamId",
    path: ["role"],
  });

export const approvalChoicesSchema = z
  .array(approvalDecisionValueSchema)
  .min(1)
  .refine((choices) => new Set(choices).size === choices.length, "choices must be unique");

export const approvalRequestSchema = z.strictObject({
  id: z.string().min(1),
  kind: approvalKindSchema,
  subjectRef: z.record(z.string(), z.unknown()),
  title: z.string(),
  summary: z.string(),
  recommendation: approvalDecisionValueSchema.nullable(),
  choices: z.array(approvalDecisionValueSchema),
  responders: approvalRespondersSchema,
  quorum: z.literal(APPROVAL_QUORUM),
  status: approvalStatusSchema,
  digest: z.string().nullable(),
  occurrenceKey: z.string().min(1),
  expiresAt: z.number().int().nullable(),
  createdBy: z.string().min(1),
  followUp: z.record(z.string(), z.unknown()).nullable(),
  decidedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const approvalDecisionSchema = z.strictObject({
  id: z.string().min(1),
  requestId: z.string().min(1),
  userId: z.string().min(1),
  decision: approvalDecisionValueSchema,
  note: z.string().nullable(),
  surface: approvalSurfaceSchema,
  decidedAt: z.number().int(),
});

/** Body of `POST /approvals`, sent by a trusted service. */
export const createApprovalRequestSchema = z
  .strictObject({
    kind: approvalKindSchema,
    subjectRef: jsonObjectWithin(MAX_APPROVAL_SUBJECT_REF_BYTES),
    title: z.string().trim().min(1).max(200),
    summary: z.string().max(4000).default(""),
    recommendation: approvalDecisionValueSchema.nullable().default(null),
    choices: approvalChoicesSchema.default(["approve", "reject"]),
    responders: approvalRespondersSchema,
    digest: z.string().min(1).max(200).nullable().default(null),
    occurrenceKey: z.string().min(1).max(200),
    expiresAt: z.number().int().positive().nullable().default(null),
    followUp: jsonObjectWithin(MAX_APPROVAL_FOLLOW_UP_BYTES).nullable().default(null),
  })
  .refine(
    (request) =>
      request.recommendation === null || request.choices.includes(request.recommendation),
    { message: "recommendation must be one of the choices", path: ["recommendation"] }
  );

const decisionFields = {
  decision: approvalDecisionValueSchema,
  note: z.string().max(2000).nullable().default(null),
};

/** Body of `POST /approvals/:id/decide`, sent for the signed-in user. */
export const decideApprovalRequestSchema = z.strictObject({
  ...decisionFields,
  surface: z.enum(["web", "api"]).default("web"),
});

/** Body of `POST /internal/approvals/:id/decide`: a trusted service records a person's tap. */
export const serviceDecideApprovalRequestSchema = z.strictObject({
  ...decisionFields,
  /** The canonical user id of the person who decided; the same responder rules apply to them. */
  actingUserId: z.string().min(1),
  surface: approvalSurfaceSchema,
});

export const approvalResponseSchema = z.strictObject({
  request: approvalRequestSchema,
  decisions: z.array(approvalDecisionSchema),
});

export const approvalListResponseSchema = z.strictObject({
  requests: z.array(approvalRequestSchema),
});

export type ApprovalKind = z.infer<typeof approvalKindSchema>;
export type ApprovalDecisionValue = z.infer<typeof approvalDecisionValueSchema>;
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
export type ApprovalSurface = z.infer<typeof approvalSurfaceSchema>;
export type ApprovalResponders = z.infer<typeof approvalRespondersSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type CreateApprovalRequest = z.infer<typeof createApprovalRequestSchema>;
export type DecideApprovalRequest = z.infer<typeof decideApprovalRequestSchema>;
export type ServiceDecideApprovalRequest = z.infer<typeof serviceDecideApprovalRequestSchema>;
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;
export type ApprovalListResponse = z.infer<typeof approvalListResponseSchema>;
