/**
 * A turn's life on one thread conversation (the thread's main session or a
 * colleague's fork): it begins with a "Working..." reply the turn owns,
 * progress is drawn under that reply, and the turn settles by writing its
 * answer over it. Closing a conversation ends its progress. Each
 * conversation keeps its own record, placeholders and progress stream, so
 * one conversation's turns never touch another's in the same thread.
 */

import type { MsTeamsCallbackContext } from "@open-inspect/shared/types/session-api";
import type { ActivityAddress, BotFrameworkClient } from "../bot-framework/client";
import type { NewThreadConversation, TeamsStateStore, ThreadConversation } from "../state/store";
import { updateOrPost, WORKING_TEXT, type ReplySinkPort } from "../teams/reply-sink";
import { progressStreamKey, type ProgressRenderer } from "./progress";

/** Where a turn's replies go: under the thread's root post. */
export interface ThreadPlace {
  address: ActivityAddress;
  rootActivityId: string;
}

/**
 * The conversation a sender's message in the thread goes to: their open fork
 * when they have one, else the thread's main conversation.
 */
export function conversationFor(
  store: TeamsStateStore,
  threadKey: string,
  actor: string
): ThreadConversation | null {
  const fork = store.getFork(threadKey, actor);
  return fork && !fork.closed ? fork : store.getMainConversation(threadKey);
}

/** What the control plane echoes back on this turn's callbacks. */
export function teamsCallbackContext(input: {
  threadKey: string;
  place: ThreadPlace;
  channelId: string | null;
  repoFullName: string | null;
  model: string;
}): MsTeamsCallbackContext {
  return {
    source: "msteams",
    conversationId: input.threadKey,
    serviceUrl: input.place.address.serviceUrl,
    replyToId: input.place.rootActivityId,
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.repoFullName ? { repoFullName: input.repoFullName } : {}),
    model: input.model,
  };
}

type TurnDeps = { store: TeamsStateStore; bot: BotFrameworkClient };

/** Post the "Working..." reply a turn owns and remember it for that turn. */
async function postWorking(
  deps: TurnDeps,
  place: ThreadPlace,
  threadKey: string,
  sessionId: string,
  messageId: string
): Promise<string | null> {
  const working = await deps.bot.replyToActivity(place.address, place.rootActivityId, WORKING_TEXT);
  const id = working.id || null;
  if (id) deps.store.putTurnPlaceholder(threadKey, sessionId, messageId, id);
  return id;
}

/**
 * Record a new conversation whose first turn (`messageId`) is in flight,
 * replacing the one in its place (the thread's main conversation, or the
 * sender's fork).
 */
export async function openConversation(
  deps: TurnDeps,
  place: ThreadPlace,
  conversation: Omit<NewThreadConversation, "progressActivityId" | "lastMessageId" | "turnState">,
  messageId: string
): Promise<ThreadConversation> {
  // Recorded before the reply exists so its placeholder is not taken for the
  // replaced conversation's; the reply id is filled in once it is posted.
  deps.store.putConversation({ ...conversation, lastMessageId: messageId, turnState: "working" });
  const progressActivityId = await postWorking(
    deps,
    place,
    conversation.threadKey,
    conversation.sessionId,
    messageId
  );
  return deps.store.updateConversation(conversation.threadKey, conversation.sessionId, {
    progressActivityId,
  })!;
}

/** A follow-up turn (`messageId`) in flight on an existing conversation. */
export async function beginTurn(
  deps: TurnDeps,
  place: ThreadPlace,
  conversation: ThreadConversation,
  messageId: string
): Promise<void> {
  const progressActivityId = await postWorking(
    deps,
    place,
    conversation.threadKey,
    conversation.sessionId,
    messageId
  );
  deps.store.updateConversation(conversation.threadKey, conversation.sessionId, {
    progressActivityId,
    lastMessageId: messageId,
    turnState: "working",
  });
}

/** The person stopped the session: its turn is no longer working. */
export function stopTurn(store: TeamsStateStore, conversation: ThreadConversation): void {
  store.updateConversation(conversation.threadKey, conversation.sessionId, { turnState: "idle" });
}

type ProgressDeps = { store: TeamsStateStore; progress: ProgressRenderer };

/** Add a progress line under the conversation's current "Working..." reply. */
export function noteProgress(
  deps: ProgressDeps,
  conversation: ThreadConversation,
  port: ReplySinkPort,
  line: string
): void {
  deps.progress.note(
    progressStreamKey(conversation.threadKey, conversation.sessionId),
    { port, progressActivityId: conversation.progressActivityId },
    line
  );
}

/**
 * Write a finished turn's answer into the turn's own "Working..." reply (or
 * post it fresh), after ending the progress stream when it was drawing this
 * turn. A turn that completes after a follow-up superseded it leaves the new
 * turn's reply and stream alone. `conversation` is null when the thread's
 * record is gone; the answer is then posted fresh.
 */
export async function settleTurn(
  deps: ProgressDeps,
  input: {
    threadKey: string;
    sessionId: string;
    conversation: ThreadConversation | null;
    messageId: string;
    port: ReplySinkPort;
    text: string;
  }
): Promise<{ finalId: string | undefined; target: string | undefined }> {
  const { conversation } = input;
  const isCurrentTurn = conversation !== null && conversation.lastMessageId === input.messageId;
  const ownPlaceholder = conversation
    ? (deps.store.getTurnPlaceholder(input.threadKey, input.messageId) ??
      (isCurrentTurn ? conversation.progressActivityId : null))
    : null;
  const progressId = await deps.progress.finish(
    progressStreamKey(input.threadKey, input.sessionId),
    ownPlaceholder ?? null
  );
  const target = progressId ?? ownPlaceholder ?? undefined;
  const finalId = await updateOrPost(input.port, target, input.text);
  if (isCurrentTurn) {
    deps.store.updateConversation(input.threadKey, input.sessionId, {
      turnState: "idle",
      progressActivityId: null,
    });
  }
  if (conversation) deps.store.deleteTurnPlaceholder(input.threadKey, input.messageId);
  return { finalId, target };
}

/** Mark the conversation closed: later replies are told so, and its completions are dropped. */
export function markConversationClosed(
  store: TeamsStateStore,
  threadKey: string,
  sessionId: string
): boolean {
  return (
    store.updateConversation(threadKey, sessionId, { closed: true, turnState: "idle" }) !== null
  );
}

/** Close the conversation and end its progress; false when the thread has no such conversation. */
export async function closeConversation(
  deps: ProgressDeps,
  threadKey: string,
  sessionId: string
): Promise<boolean> {
  const closed = markConversationClosed(deps.store, threadKey, sessionId);
  await deps.progress.finish(progressStreamKey(threadKey, sessionId));
  return closed;
}
