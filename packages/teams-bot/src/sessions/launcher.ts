/**
 * Sending a prompt into a thread conversation: starting a session from a
 * channel mention, and following up in the conversation a sender's reply
 * goes to, which forks to a session of the sender's own when the thread's
 * session runs on a subscription home they may not spend. Every
 * control-plane call carries the Teams user as actor; every denial is
 * rendered in the thread.
 */

import type { HarnessId } from "@open-inspect/shared/harnesses";
import {
  extractProviderAndModel,
  getReasoningConfig,
  isValidModel,
  isValidReasoningEffort,
  normalizeModelId,
} from "@open-inspect/shared/models";
import type { InlinePromptOptions } from "@open-inspect/shared/inline-prompt-flags";
import type { ActivityAddress, BotFrameworkClient } from "../bot-framework/client";
import type { ControlPlaneClient } from "../control-plane/client";
import { type ControlPlaneFailure, type ControlPlaneResult } from "../control-plane/client";
import type { Logger } from "../logger";
import type { TeamsStateStore, ThreadConversation } from "../state/store";
import { toStoredConversationReference } from "../teams/conversation-reference";
import { teamsGetChannelId } from "../teams/message";
import type { TeamsActivity } from "../types";
import type { RepositoryRef } from "./commands";
import {
  beginTurn,
  markConversationClosed,
  openConversation,
  teamsCallbackContext,
  type ThreadPlace,
} from "./thread-turn";
import {
  BINDING_UNAVAILABLE_MESSAGE,
  FOLLOW_UP_FAILED_MESSAGE,
  chooseRepositoryMessage,
  DEFAULT_FORBIDDEN_MESSAGE,
  DEFAULT_QUOTA_MESSAGE,
  DEFAULT_RATE_LIMITED_MESSAGE,
  NOT_A_CHANNEL_MESSAGE,
  PROMPT_FAILED_MESSAGE,
  SESSION_CREATE_FAILED_MESSAGE,
  SESSION_NOT_ACCESSIBLE_MESSAGE,
  signInMessage,
  THREAD_CLOSED_MESSAGE,
  UNBOUND_CHANNEL_MESSAGE,
} from "./messages";

export interface LaunchDeps {
  controlPlane: ControlPlaneClient;
  bot: BotFrameworkClient;
  store: TeamsStateStore;
  log: Logger;
  webAppUrl: string;
  /** What a new session runs on unless the message carries `!model`/`!reasoning` (config.ts). */
  defaultModel: string;
  defaultReasoningEffort?: string;
}

interface ModelSelection {
  model: string;
  reasoningEffort?: string;
}

/**
 * The harness a Teams session runs its model on. Subscriptions are spent
 * only through their own CLIs on the sender's subscription home: OpenAI
 * through Codex (there is no OpenAI key) and Anthropic through the Claude
 * Agent, whose wrapper reads the home's setup token (OpenCode cannot). Any
 * other model keeps the control plane's built-in harness.
 */
function harnessForModel(model: string): HarnessId | undefined {
  const { provider } = extractProviderAndModel(model);
  if (provider === "openai") return "codex";
  if (provider === "anthropic") return "claude";
  return undefined;
}

/** Apply inline flags to the defaults, or say why they cannot be applied. */
function resolveModelSelection(
  options: InlinePromptOptions,
  defaults: ModelSelection
): { ok: true; selection: ModelSelection } | { ok: false; error: string } {
  let model = defaults.model;
  if (options.model) {
    if (!isValidModel(options.model)) {
      return { ok: false, error: `Unknown model "${options.model}".` };
    }
    model = normalizeModelId(options.model);
  }
  let reasoningEffort = options.model ? undefined : defaults.reasoningEffort;
  if (options.reasoningEffort) {
    if (!isValidReasoningEffort(model, options.reasoningEffort)) {
      const efforts = getReasoningConfig(model)?.efforts;
      const suffix = efforts?.length
        ? ` Supported values: ${efforts.join(", ")}.`
        : " This model does not support reasoning controls.";
      return {
        ok: false,
        error: `Reasoning effort "${options.reasoningEffort}" is not valid for "${model}".${suffix}`,
      };
    }
    reasoningEffort = options.reasoningEffort;
  }
  return { ok: true, selection: { model, ...(reasoningEffort ? { reasoningEffort } : {}) } };
}

/** The text a control-plane failure shows the user; the control plane's own message when it sent one. */
export function renderFailure(
  failure: ControlPlaneFailure,
  webAppUrl: string,
  fallback: string
): string {
  switch (failure.reason) {
    case "not_enrolled":
      return signInMessage(webAppUrl);
    case "quota":
      return failure.message ?? DEFAULT_QUOTA_MESSAGE;
    case "rate_limited":
      return failure.message ?? DEFAULT_RATE_LIMITED_MESSAGE;
    case "forbidden":
    case "no_eligible_home":
      return failure.message ?? DEFAULT_FORBIDDEN_MESSAGE;
    case "invalid":
      return failure.message ?? fallback;
    default:
      return fallback;
  }
}

export interface LaunchInput {
  activity: TeamsActivity;
  threadKey: string;
  address: ActivityAddress;
  /** The root post of the thread; replies go under it. */
  rootActivityId: string;
  actor: string;
  repo: RepositoryRef | null;
  prompt: string;
  options: InlinePromptOptions;
  traceId: string;
  /**
   * The sender's own session for a follow-up the thread's session refused:
   * recorded as the sender's fork, leaving the thread's main conversation to
   * everyone else.
   */
  fork?: boolean;
}

async function resolveRepository(
  deps: LaunchDeps,
  input: LaunchInput,
  channelId: string
): Promise<ControlPlaneResult<RepositoryRef | null>> {
  if (input.repo) return { ok: true, data: input.repo };
  const repos = await deps.controlPlane.listRepositories(input.actor, channelId, input.traceId);
  if (!repos.ok) return repos;
  if (repos.data.length === 1) {
    const [only] = repos.data;
    return { ok: true, data: { owner: only.owner, name: only.name, fullName: only.fullName } };
  }
  await deps.bot.replyToActivity(
    input.address,
    input.rootActivityId,
    chooseRepositoryMessage(repos.data.map((repo) => repo.fullName))
  );
  return { ok: true, data: null };
}

/** Start a session for a channel mention and send its first prompt. Replies in the thread on every outcome. */
export async function launchSession(deps: LaunchDeps, input: LaunchInput): Promise<void> {
  const { activity, address, rootActivityId, actor, traceId } = input;
  const reply = (text: string) => deps.bot.replyToActivity(address, rootActivityId, text);
  const logBase = { trace_id: traceId, thread_key: input.threadKey, actor };

  const channelId = teamsGetChannelId(activity);
  if (!channelId) {
    await reply(NOT_A_CHANNEL_MESSAGE);
    return;
  }

  const binding = await deps.controlPlane.lookupChannelBinding(channelId, traceId);
  if (binding.kind !== "resolved" || binding.binding.teamId === null) {
    deps.log.info("launch.rejected", {
      ...logBase,
      channel_id: channelId,
      reject_reason: binding.kind === "unavailable" ? "binding_unavailable" : "channel_unbound",
    });
    await reply(
      binding.kind === "unavailable" ? BINDING_UNAVAILABLE_MESSAGE : UNBOUND_CHANNEL_MESSAGE
    );
    return;
  }
  const teamId = binding.binding.teamId;

  const selection = resolveModelSelection(input.options, {
    model: deps.defaultModel,
    reasoningEffort: deps.defaultReasoningEffort,
  });
  if (!selection.ok) {
    await reply(selection.error);
    return;
  }

  const repo = await resolveRepository(deps, input, channelId);
  if (!repo.ok) {
    await reply(renderFailure(repo, deps.webAppUrl, SESSION_CREATE_FAILED_MESSAGE));
    return;
  }
  if (!repo.data) return;

  const session = await deps.controlPlane.createSession(
    actor,
    {
      teamId,
      repoOwner: repo.data.owner,
      repoName: repo.data.name,
      model: selection.selection.model,
      harness: harnessForModel(selection.selection.model),
      reasoningEffort: selection.selection.reasoningEffort,
      actorDisplayName: activity.from?.name,
    },
    traceId
  );
  if (!session.ok) {
    deps.log.info("launch.rejected", {
      ...logBase,
      team_id: teamId,
      reject_reason: session.reason,
      http_status: session.status,
      code: session.code,
    });
    await reply(renderFailure(session, deps.webAppUrl, SESSION_CREATE_FAILED_MESSAGE));
    return;
  }
  const sessionId = session.data.sessionId;

  const place: ThreadPlace = { address, rootActivityId };
  const callbackContext = teamsCallbackContext({
    threadKey: input.threadKey,
    place,
    channelId,
    repoFullName: repo.data.fullName,
    model: selection.selection.model,
  });
  const prompt = await deps.controlPlane.sendPrompt(
    actor,
    sessionId,
    {
      content: input.prompt,
      model: selection.selection.model,
      reasoningEffort: selection.selection.reasoningEffort,
      callbackContext,
    },
    traceId
  );
  if (!prompt.ok) {
    deps.log.info("launch.prompt_rejected", {
      ...logBase,
      session_id: sessionId,
      reject_reason: prompt.reason,
      http_status: prompt.status,
      code: prompt.code,
    });
    await reply(renderFailure(prompt, deps.webAppUrl, PROMPT_FAILED_MESSAGE));
    return;
  }

  await openConversation(
    deps,
    place,
    {
      threadKey: input.threadKey,
      sessionId,
      forkActor: input.fork ? actor : null,
      actor,
      teamId,
      repoFullName: repo.data.fullName,
      model: selection.selection.model,
      reasoningEffort: selection.selection.reasoningEffort ?? null,
      serviceUrl: address.serviceUrl,
      channelId,
      rootActivityId,
    },
    prompt.data.messageId
  );
  deps.store.putConversationReference(input.threadKey, toStoredConversationReference(activity));
  deps.log.info("launch.started", {
    ...logBase,
    team_id: teamId,
    session_id: sessionId,
    message_id: prompt.data.messageId,
    repo: repo.data.fullName,
    model: selection.selection.model,
  });
}

export interface FollowUpInput {
  activity: TeamsActivity;
  threadKey: string;
  address: ActivityAddress;
  rootActivityId: string;
  actor: string;
  /** The conversation the sender's reply goes to (`conversationFor`). */
  conversation: ThreadConversation;
  /** The prompt, with any quoted-reply context already prefixed. */
  content: string;
  options: InlinePromptOptions;
  traceId: string;
}

/** The repository a conversation's session runs on, for a fork that starts its own session. */
function conversationRepository(conversation: ThreadConversation): RepositoryRef | null {
  if (!conversation.repoFullName) return null;
  const slash = conversation.repoFullName.lastIndexOf("/");
  if (slash <= 0) return null;
  return {
    owner: conversation.repoFullName.slice(0, slash),
    name: conversation.repoFullName.slice(slash + 1),
    fullName: conversation.repoFullName,
  };
}

/**
 * Send a reply in the thread to its conversation as the next turn. Replies
 * in the thread on every outcome; a reply the conversation's subscription
 * home refuses becomes the sender's fork.
 */
export async function followUp(deps: LaunchDeps, input: FollowUpInput): Promise<void> {
  const { conversation } = input;
  const place: ThreadPlace = { address: input.address, rootActivityId: input.rootActivityId };
  const reply = (text: string) =>
    deps.bot.replyToActivity(input.address, input.rootActivityId, text);
  const logBase = {
    trace_id: input.traceId,
    thread_key: input.threadKey,
    session_id: conversation.sessionId,
  };
  if (conversation.closed) {
    await reply(THREAD_CLOSED_MESSAGE);
    return;
  }
  const selection = resolveModelSelection(input.options, {
    model: conversation.model,
    reasoningEffort: conversation.reasoningEffort ?? undefined,
  });
  if (!selection.ok) {
    await reply(selection.error);
    return;
  }
  const overrides = input.options.model || input.options.reasoningEffort ? selection.selection : {};
  const prompt = await deps.controlPlane.sendPrompt(
    input.actor,
    conversation.sessionId,
    {
      content: input.content,
      ...overrides,
      callbackContext: teamsCallbackContext({
        threadKey: input.threadKey,
        place,
        channelId: conversation.channelId,
        repoFullName: conversation.repoFullName,
        model: selection.selection.model,
      }),
    },
    input.traceId
  );
  if (!prompt.ok) {
    if (prompt.reason === "no_eligible_home") {
      // The conversation's session runs on a subscription home this sender
      // may not spend: the follow-up becomes a session of the sender's own,
      // resolved for them (and refused with its own message if none fits).
      // It is the sender's fork: the thread keeps its session for its owner,
      // and the sender's later replies go to the fork.
      deps.log.info("follow_up.forked", logBase);
      await launchSession(deps, {
        activity: input.activity,
        threadKey: input.threadKey,
        address: input.address,
        rootActivityId: input.rootActivityId,
        actor: input.actor,
        repo: conversationRepository(conversation),
        prompt: input.content,
        options: { ...input.options, model: selection.selection.model },
        traceId: input.traceId,
        fork: true,
      });
      return;
    }
    if (prompt.reason === "not_found") {
      // The control plane also answers 404 when THIS user may not read the
      // session (private, or team enforcement), so only the user who started
      // it can tell us the session is really gone; anyone else is told they
      // cannot reach it, and the thread stays open for its owner.
      if (conversation.actor === input.actor) {
        markConversationClosed(deps.store, input.threadKey, conversation.sessionId);
        await reply(THREAD_CLOSED_MESSAGE);
        return;
      }
      deps.log.info("follow_up.denied", { ...logBase, http_status: prompt.status });
      await reply(SESSION_NOT_ACCESSIBLE_MESSAGE);
      return;
    }
    await reply(renderFailure(prompt, deps.webAppUrl, FOLLOW_UP_FAILED_MESSAGE));
    return;
  }
  await beginTurn(deps, place, conversation, prompt.data.messageId);
  deps.log.info("follow_up.sent", { ...logBase, message_id: prompt.data.messageId });
}
