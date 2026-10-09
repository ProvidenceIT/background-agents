import type { TriggerKind } from "@open-inspect/shared/types/auth-homes";
import type { CreateSessionInput } from "@open-inspect/shared/types/session-api";
import type { UserStore } from "../db/user-store";
import { error } from "../http/responses";
import type { RequestContext } from "../http/request-context";

/** Kinds a bot may name when it creates a session; `child` and `schedule` are server-assigned. */
const BOT_TRIGGER_KINDS: ReadonlySet<TriggerKind> = new Set(["mention", "issue_label", "pr_event"]);

export interface SessionTrigger {
  triggerKind: TriggerKind;
  /** The workspace user linked to the work item's SCM author, or null. */
  workItemAuthorUserId: string | null;
}

/** Whether the request comes from a bot service rather than a person or the web app. */
function isBotPrincipal(ctx: RequestContext): boolean {
  return ctx.principal?.kind === "service" && ctx.principal.service !== "web";
}

/**
 * The trigger of a created session. A person's request is always `prompt`
 * and may not name a kind or a work-item author (400). A bot may name
 * `mention`, `issue_label` or `pr_event`, and the GitHub user id of the
 * issue or pull request author, which is resolved to a workspace user only
 * for the audit; the actor stays the admitted user.
 */
export async function resolveSessionTrigger(
  ctx: RequestContext,
  users: Pick<UserStore, "getIdentity">,
  body: Pick<CreateSessionInput, "triggerKind" | "workItemAuthorScmUserId">
): Promise<SessionTrigger | Response> {
  const named = body.triggerKind !== undefined || body.workItemAuthorScmUserId !== undefined;
  if (!isBotPrincipal(ctx)) {
    if (named) return error("triggerKind and workItemAuthorScmUserId are set by bots only", 400);
    return { triggerKind: "prompt", workItemAuthorUserId: null };
  }
  const triggerKind = body.triggerKind ?? "prompt";
  if (triggerKind !== "prompt" && !BOT_TRIGGER_KINDS.has(triggerKind)) {
    return error(`Trigger kind '${triggerKind}' is assigned by the control plane`, 400);
  }
  const authorScmUserId = body.workItemAuthorScmUserId;
  const workItemAuthorUserId = authorScmUserId
    ? ((await users.getIdentity("github", authorScmUserId))?.userId ?? null)
    : null;
  return { triggerKind, workItemAuthorUserId };
}
