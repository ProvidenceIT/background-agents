import {
  createSessionResponseSchema,
  sendPromptResponseSchema,
} from "@open-inspect/shared/types/session-api";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import type { TriggerKind } from "@open-inspect/shared/types/auth-homes";
import { z } from "zod";
import { signedControlPlaneFetch } from "./internal-auth";
import type { Env } from "./types";
import type { SessionTargetFields } from "./session-target";

const sessionCreationErrorSchema = z.object({ code: z.string() });

/** Trigger kinds a GitHub event can start a session with. */
export type GitHubTriggerKind = Extract<TriggerKind, "issue_label" | "pr_event">;

export type SessionCreationResult =
  | { ok: true; sessionId: string }
  | { ok: false; status: number; code: string | undefined; body: string };

export async function createSession(
  env: Env,
  traceId: string,
  params: {
    target: SessionTargetFields;
    teamId: string | null;
    title: string;
    model: string;
    harness: HarnessId;
    reasoningEffort?: string | null;
    scmLogin: string;
    /** The event sender: the only identity the session is attributed to. */
    scmUserId: string;
    scmAvatarUrl: string;
    triggerKind: GitHubTriggerKind;
    /** The pull request or issue author's numeric id; audited, never the actor. */
    workItemAuthorScmUserId?: string;
  }
): Promise<SessionCreationResult> {
  const body: Record<string, unknown> = {
    ...params.target,
    teamId: params.teamId,
    title: params.title,
    model: params.model,
    harness: params.harness,
    scmLogin: params.scmLogin,
    scmAvatarUrl: params.scmAvatarUrl,
    triggerKind: params.triggerKind,
  };
  if (params.workItemAuthorScmUserId) {
    body.workItemAuthorScmUserId = params.workItemAuthorScmUserId;
  }
  if (params.reasoningEffort) {
    body.reasoningEffort = params.reasoningEffort;
  }
  const url = "https://internal/sessions";
  const bodyText = JSON.stringify(body);
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url,
    body: bodyText,
    actor: `github:${params.scmUserId}`,
    traceId,
  });
  if (!response.ok) {
    const parsed = sessionCreationErrorSchema.safeParse(
      await response
        .clone()
        .json()
        .catch(() => null)
    );
    return {
      ok: false,
      status: response.status,
      code: parsed.success ? parsed.data.code : undefined,
      body: await response.text(),
    };
  }
  const result = createSessionResponseSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error("Session creation failed: invalid response");
  }
  return { ok: true, sessionId: result.data.sessionId };
}

export async function sendPrompt(
  env: Env,
  traceId: string,
  sessionId: string,
  params: { content: string; authorId: string }
): Promise<string> {
  const url = `https://internal/sessions/${sessionId}/prompt`;
  // Every turn this bot relays is a pull-request event; the control plane
  // gates the session's subscription home on that kind.
  const bodyText = JSON.stringify({
    content: params.content,
    source: "github",
    triggerKind: "pr_event",
  });
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url,
    body: bodyText,
    actor: params.authorId.startsWith("github:") ? params.authorId : undefined,
    traceId,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Prompt delivery failed: ${response.status} ${body}`);
  }
  const result = sendPromptResponseSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error("Prompt delivery failed: invalid response");
  }
  return result.data.messageId;
}
