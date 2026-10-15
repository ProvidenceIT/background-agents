import { triggerKindSchema } from "@open-inspect/shared/types/auth-homes";
import { messageSourceSchema } from "@open-inspect/shared/types/sessions";
import { sessionAttachmentReferencesSchema } from "@open-inspect/shared/types/session-attachments";
import {
  BLANK_PROMPT_MESSAGE,
  isBlankPrompt,
  promptContentSchema,
} from "@open-inspect/shared/types/prompts";
import { z } from "zod";

/**
 * How the queue admits this turn on the session's subscription home (ADR
 * 0005). Required, so no caller skips the check by leaving it out:
 * `admitted: "at_create"` for the first prompt of a session whose creation
 * (child spawn, scheduled run) bound the home and audited the turn; otherwise
 * the trigger kind and channel to check, with `canonicalUserId` as the actor.
 */
const enqueuePromptTurnSchema = z.union([
  z.object({ admitted: z.literal("at_create") }),
  z.object({
    triggerKind: triggerKindSchema,
    channel: z.enum(["prompt", "slack_steer", "child_prompt"]),
    requestId: z.string().min(1),
  }),
]);

export const enqueuePromptRequestSchema = z
  .object({
    turn: enqueuePromptTurnSchema,
    content: promptContentSchema,
    authorId: z.string(),
    canonicalUserId: z.string().nullable().optional(),
    source: messageSourceSchema,
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    attachments: sessionAttachmentReferencesSchema.optional(),
    callbackContext: z.record(z.string(), z.unknown()).optional(),
    /**
     * Idempotency key, already namespaced by the router to the calling
     * service; shares the session's `client_request_id` index with web prompts.
     */
    clientRequestId: z.string().min(1).optional(),
    // Authoritative SCM snapshot resolved by the router at prompt time.
    // Explicit null fields clear stored attribution; absence leaves it unchanged.
    scmEnrichment: z
      .object({
        userId: z.string().nullable(),
        login: z.string().nullable(),
        name: z.string().nullable(),
        email: z.string().nullable(),
      })
      .optional(),
  })
  .refine((prompt) => !isBlankPrompt(prompt), {
    message: BLANK_PROMPT_MESSAGE,
    path: ["content"],
  });

export type EnqueuePromptRequest = z.infer<typeof enqueuePromptRequestSchema>;
