import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { STALE_CALLBACK_CLAIM_MS, STATE_FILE_NAME, TeamsStateStore } from "./store";

const threadKey = "19:chan@thread.tacv2;messageid=100";

const COLLEAGUE = "microsoft:99999999-8888-7777-6666-555555555555";

function newConversation(
  overrides: Partial<Parameters<TeamsStateStore["putConversation"]>[0]> = {}
) {
  return {
    threadKey,
    sessionId: "session-1",
    forkActor: null,
    actor: "microsoft:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    teamId: "team-platform",
    repoFullName: "ProvidenceIT/playground",
    model: "anthropic/claude-sonnet-4.5",
    reasoningEffort: null,
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    channelId: "19:chan@thread.tacv2",
    rootActivityId: "100",
    ...overrides,
  };
}

const newFork = (overrides: Partial<Parameters<TeamsStateStore["putConversation"]>[0]> = {}) =>
  newConversation({
    sessionId: "session-fork",
    forkActor: COLLEAGUE,
    actor: COLLEAGUE,
    ...overrides,
  });

describe("TeamsStateStore", () => {
  const stores: TeamsStateStore[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function open(now?: () => number) {
    const store = TeamsStateStore.inMemory(now);
    stores.push(store);
    return store;
  }

  it("records the thread's main conversation and reads it back", () => {
    let now = 1_000;
    const store = open(() => now);
    const stored = store.putConversation(
      newConversation({ progressActivityId: "reply-1", lastMessageId: "m-1", turnState: "working" })
    );
    expect(stored).toEqual({
      threadKey,
      sessionId: "session-1",
      forkActor: null,
      actor: "microsoft:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
      teamId: "team-platform",
      repoFullName: "ProvidenceIT/playground",
      model: "anthropic/claude-sonnet-4.5",
      reasoningEffort: null,
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      channelId: "19:chan@thread.tacv2",
      rootActivityId: "100",
      progressActivityId: "reply-1",
      lastMessageId: "m-1",
      turnState: "working",
      closed: false,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(store.getMainConversation("other")).toBeNull();
    expect(store.getConversation(threadKey, "session-1")).toEqual(stored);
    now = 2_000;
    expect(
      store.updateConversation(threadKey, "session-1", {
        turnState: "idle",
        progressActivityId: null,
      })
    ).toMatchObject({
      turnState: "idle",
      progressActivityId: null,
      lastMessageId: "m-1",
      updatedAt: 2_000,
    });
    expect(store.updateConversation(threadKey, "missing", { turnState: "idle" })).toBeNull();
  });

  it("keeps a colleague's fork beside the main conversation and updates each by session", () => {
    const store = open();
    store.putConversation(newConversation());
    store.putConversation(newFork());

    expect(store.getMainConversation(threadKey)?.sessionId).toBe("session-1");
    expect(store.getFork(threadKey, COLLEAGUE)?.sessionId).toBe("session-fork");
    expect(store.getFork(threadKey, "microsoft:someone-else")).toBeNull();
    expect(store.getConversation(threadKey, "session-fork")?.forkActor).toBe(COLLEAGUE);
    expect(store.getConversation(threadKey, "session-3")).toBeNull();

    store.updateConversation(threadKey, "session-fork", {
      turnState: "working",
      lastMessageId: "m-2",
    });
    expect(store.getFork(threadKey, COLLEAGUE)).toMatchObject({
      turnState: "working",
      lastMessageId: "m-2",
    });
    expect(store.getMainConversation(threadKey)).toMatchObject({
      turnState: "idle",
      lastMessageId: null,
    });
  });

  it("replaces only the conversation in the same place, with its placeholders", () => {
    const store = open();
    store.putConversation(newConversation());
    store.putConversation(newFork());
    store.putTurnPlaceholder(threadKey, "session-1", "m-1", "reply-1");
    store.putTurnPlaceholder(threadKey, "session-fork", "fm-1", "fork-reply-1");

    store.putConversation(newConversation({ sessionId: "session-2" }));
    expect(store.getMainConversation(threadKey)?.sessionId).toBe("session-2");
    expect(store.getConversation(threadKey, "session-1")).toBeNull();
    expect(store.getTurnPlaceholder(threadKey, "m-1")).toBeNull();
    expect(store.getFork(threadKey, COLLEAGUE)?.sessionId).toBe("session-fork");
    expect(store.getTurnPlaceholder(threadKey, "fm-1")).toBe("fork-reply-1");

    store.putConversation(newFork({ sessionId: "session-fork-2" }));
    expect(store.getFork(threadKey, COLLEAGUE)?.sessionId).toBe("session-fork-2");
    expect(store.getTurnPlaceholder(threadKey, "fm-1")).toBeNull();
    expect(store.getMainConversation(threadKey)?.sessionId).toBe("session-2");
  });

  it("remembers each turn's placeholder until the turn completes", () => {
    const store = open();
    store.putConversation(newConversation());
    expect(store.getTurnPlaceholder(threadKey, "m-1")).toBeNull();
    store.putTurnPlaceholder(threadKey, "session-1", "m-1", "reply-1");
    store.putTurnPlaceholder(threadKey, "session-1", "m-2", "reply-2");
    store.putTurnPlaceholder(threadKey, "session-1", "m-2", "reply-2b");
    expect(store.getTurnPlaceholder(threadKey, "m-1")).toBe("reply-1");
    expect(store.getTurnPlaceholder(threadKey, "m-2")).toBe("reply-2b");
    store.deleteTurnPlaceholder(threadKey, "m-1");
    expect(store.getTurnPlaceholder(threadKey, "m-1")).toBeNull();
  });

  it("keeps conversation references and tolerates corrupt ones", () => {
    const store = open();
    expect(store.getConversationReference(threadKey)).toBeNull();
    store.putConversationReference(threadKey, {
      conversationId: threadKey,
      serviceUrl: "https://smba.trafficmanager.net/",
    });
    store.putConversationReference(threadKey, { conversationId: threadKey, activityId: "100" });
    expect(store.getConversationReference(threadKey)).toEqual({
      conversationId: threadKey,
      activityId: "100",
    });
  });

  it("claims each inbound activity once and prunes old claims", () => {
    let now = 10_000;
    const store = open(() => now);
    expect(store.claimInboundActivity("a-1")).toBe(true);
    expect(store.claimInboundActivity("a-1")).toBe(false);
    now = 20_000;
    expect(store.claimInboundActivity("a-2")).toBe(true);
    expect(store.pruneInboundActivities(5_000)).toBe(1);
    expect(store.claimInboundActivity("a-1")).toBe(true);
    expect(store.claimInboundActivity("a-2")).toBe(false);
  });

  it("dedupes callbacks by (messageId, kind) and lets a released claim through again", () => {
    const store = open();
    expect(store.claimCallback("m-1", "complete")).toBe(true);
    expect(store.claimCallback("m-1", "complete")).toBe(false);
    expect(store.claimCallback("m-1", "tool_call")).toBe(true);
    expect(store.claimCallback("m-2", "complete")).toBe(true);
    store.releaseCallback("m-1", "complete");
    expect(store.claimCallback("m-1", "complete")).toBe(true);
  });

  it("lets an unfinished claim expire but never a posted one", () => {
    let now = 1_000_000;
    const store = open(() => now);
    expect(store.claimCallback("m-1", "complete")).toBe(true);
    expect(store.claimCallback("m-2", "complete")).toBe(true);
    store.markCallbackPosted("m-2", "complete");
    now += STALE_CALLBACK_CLAIM_MS - 1;
    expect(store.claimCallback("m-1", "complete")).toBe(false);
    now += 1;
    expect(store.claimCallback("m-1", "complete")).toBe(true);
    expect(store.claimCallback("m-1", "complete")).toBe(false);
    now += STALE_CALLBACK_CLAIM_MS * 10;
    expect(store.claimCallback("m-2", "complete")).toBe(false);
  });

  it("releases every unfinished claim at startup and keeps the posted ones", () => {
    const store = open();
    store.claimCallback("m-1", "complete");
    store.claimCallback("m-2", "complete");
    store.markCallbackPosted("m-2", "complete");
    store.claimCallback("s-1", "thread_closed");
    expect(store.releaseUnpostedCallbacks()).toBe(2);
    expect(store.claimCallback("m-1", "complete")).toBe(true);
    expect(store.claimCallback("s-1", "thread_closed")).toBe(true);
    expect(store.claimCallback("m-2", "complete")).toBe(false);
  });

  it("adds the posted_at column to a database created before it existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "teams-bot-state-"));
    dirs.push(dir);
    const legacy = new DatabaseSync(join(dir, STATE_FILE_NAME));
    legacy.exec(
      `CREATE TABLE callback_deliveries (
         message_id TEXT NOT NULL, kind TEXT NOT NULL, claimed_at INTEGER NOT NULL,
         PRIMARY KEY (message_id, kind));
       INSERT INTO callback_deliveries VALUES ('m-old', 'complete', 1);`
    );
    legacy.close();
    const store = TeamsStateStore.open(dir);
    stores.push(store);
    expect(store.claimCallback("m-old", "complete")).toBe(true);
    store.markCallbackPosted("m-old", "complete");
    expect(store.releaseUnpostedCallbacks()).toBe(0);
  });

  it("merges a database's legacy thread and fork tables into conversations", () => {
    const dir = mkdtempSync(join(tmpdir(), "teams-bot-state-"));
    dirs.push(dir);
    const legacy = new DatabaseSync(join(dir, STATE_FILE_NAME));
    const columns = `thread_key TEXT NOT NULL, session_id TEXT NOT NULL, actor TEXT, team_id TEXT,
      repo_full_name TEXT, model TEXT NOT NULL, reasoning_effort TEXT, service_url TEXT NOT NULL,
      channel_id TEXT, root_activity_id TEXT, progress_activity_id TEXT, last_message_id TEXT,
      turn_state TEXT NOT NULL DEFAULT 'idle', closed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`;
    const row = (session: string, actor: string, state: string) =>
      `('${threadKey}', '${session}', '${actor}', 'team-platform', 'ProvidenceIT/playground',
        'anthropic/claude-sonnet-4.5', NULL, 'https://smba.trafficmanager.net/emea/',
        '19:chan@thread.tacv2', '100', 'reply-${session}', 'm-${session}', '${state}', 0, 1, 2)`;
    legacy.exec(
      `CREATE TABLE thread_sessions (${columns});
       CREATE TABLE thread_forks (${columns});
       CREATE TABLE turn_placeholders (
         thread_key TEXT NOT NULL, message_id TEXT NOT NULL,
         progress_activity_id TEXT NOT NULL, created_at INTEGER NOT NULL,
         PRIMARY KEY (thread_key, message_id));
       INSERT INTO thread_sessions VALUES ${row("session-1", "microsoft:owner", "working")};
       INSERT INTO thread_forks VALUES ${row("session-fork", COLLEAGUE, "idle")};
       INSERT INTO turn_placeholders VALUES ('${threadKey}', 'm-old', 'reply-old', 1);`
    );
    legacy.close();
    const store = TeamsStateStore.open(dir);
    stores.push(store);

    expect(store.getMainConversation(threadKey)).toMatchObject({
      sessionId: "session-1",
      forkActor: null,
      actor: "microsoft:owner",
      progressActivityId: "reply-session-1",
      turnState: "working",
      createdAt: 1,
    });
    expect(store.getFork(threadKey, COLLEAGUE)).toMatchObject({
      sessionId: "session-fork",
      forkActor: COLLEAGUE,
      lastMessageId: "m-session-fork",
    });
    // A placeholder from before placeholders carried a session is the main conversation's.
    expect(store.getTurnPlaceholder(threadKey, "m-old")).toBe("reply-old");
    store.putConversation(newConversation({ sessionId: "session-2" }));
    expect(store.getTurnPlaceholder(threadKey, "m-old")).toBeNull();
  });

  it("persists to a file under the state directory and survives reopening", () => {
    const dir = mkdtempSync(join(tmpdir(), "teams-bot-state-"));
    dirs.push(dir);
    const first = TeamsStateStore.open(join(dir, "nested"));
    first.putConversation(newConversation());
    first.close();
    const second = TeamsStateStore.open(join(dir, "nested"));
    stores.push(second);
    expect(second.getMainConversation(threadKey)?.sessionId).toBe("session-1");
    expect(STATE_FILE_NAME).toBe("teams-bot.sqlite");
  });
});
