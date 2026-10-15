import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { STALE_CALLBACK_CLAIM_MS, STATE_FILE_NAME, TeamsStateStore } from "./store";

const threadKey = "19:chan@thread.tacv2;messageid=100";

function newSession(overrides: Partial<Parameters<TeamsStateStore["putThreadSession"]>[0]> = {}) {
  return {
    threadKey,
    sessionId: "session-1",
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

  it("maps a thread to its session and reads it back", () => {
    let now = 1_000;
    const store = open(() => now);
    const stored = store.putThreadSession(
      newSession({ progressActivityId: "reply-1", lastMessageId: "m-1", turnState: "working" })
    );
    expect(stored).toEqual({
      threadKey,
      sessionId: "session-1",
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
    expect(store.getThreadSession("other")).toBeNull();
    now = 2_000;
    expect(
      store.updateThreadSession(threadKey, { turnState: "idle", progressActivityId: null })
    ).toMatchObject({
      turnState: "idle",
      progressActivityId: null,
      lastMessageId: "m-1",
      updatedAt: 2_000,
    });
    expect(store.updateThreadSession("missing", { turnState: "idle" })).toBeNull();
    expect(store.findThreadSessionsBySessionId("session-1").map((row) => row.threadKey)).toEqual([
      threadKey,
    ]);
  });

  it("closes a thread only for the session it maps to", () => {
    const store = open();
    store.putThreadSession(newSession({ turnState: "working" }));
    expect(store.closeThreadSession(threadKey, "session-other")).toBe(false);
    expect(store.getThreadSession(threadKey)?.closed).toBe(false);
    expect(store.closeThreadSession(threadKey, "session-1")).toBe(true);
    expect(store.getThreadSession(threadKey)).toMatchObject({ closed: true, turnState: "idle" });
  });

  it("keeps a sender's fork beside the thread's own session and updates each by session", () => {
    const store = open();
    store.putThreadSession(newSession());
    const colleague = "microsoft:99999999-8888-7777-6666-555555555555";
    store.putThreadFork({ ...newSession({ sessionId: "session-2" }), actor: colleague });

    expect(store.getThreadSession(threadKey)?.sessionId).toBe("session-1");
    expect(store.getThreadFork(threadKey, colleague)?.sessionId).toBe("session-2");
    expect(store.getThreadFork(threadKey, "microsoft:someone-else")).toBeNull();
    expect(store.getThreadRecord(threadKey, "session-2")?.actor).toBe(colleague);
    expect(store.getThreadRecord(threadKey, "session-3")).toBeNull();

    store.updateThreadRecord(threadKey, "session-2", {
      turnState: "working",
      lastMessageId: "m-2",
    });
    expect(store.getThreadFork(threadKey, colleague)).toMatchObject({
      turnState: "working",
      lastMessageId: "m-2",
    });
    expect(store.getThreadSession(threadKey)).toMatchObject({
      turnState: "idle",
      lastMessageId: null,
    });

    expect(store.closeThreadRecord(threadKey, "session-2")).toBe(true);
    expect(store.getThreadFork(threadKey, colleague)?.closed).toBe(true);
    expect(store.getThreadSession(threadKey)?.closed).toBe(false);
    expect(store.closeThreadRecord(threadKey, "session-3")).toBe(false);
  });

  it("replaces the mapping when a new session starts in the same thread", () => {
    const store = open();
    store.putThreadSession(newSession());
    store.putThreadSession(newSession({ sessionId: "session-2" }));
    expect(store.getThreadSession(threadKey)?.sessionId).toBe("session-2");
    expect(store.findThreadSessionsBySessionId("session-1")).toEqual([]);
  });

  it("remembers each turn's placeholder until the turn completes or the thread is remapped", () => {
    const store = open();
    store.putThreadSession(newSession());
    expect(store.getTurnPlaceholder(threadKey, "m-1")).toBeNull();
    store.putTurnPlaceholder(threadKey, "session-1", "m-1", "reply-1");
    store.putTurnPlaceholder(threadKey, "session-1", "m-2", "reply-2");
    store.putTurnPlaceholder(threadKey, "session-1", "m-2", "reply-2b");
    expect(store.getTurnPlaceholder(threadKey, "m-1")).toBe("reply-1");
    expect(store.getTurnPlaceholder(threadKey, "m-2")).toBe("reply-2b");
    store.deleteTurnPlaceholder(threadKey, "m-1");
    expect(store.getTurnPlaceholder(threadKey, "m-1")).toBeNull();
    store.putThreadSession(newSession({ sessionId: "session-2" }));
    expect(store.getTurnPlaceholder(threadKey, "m-2")).toBeNull();
  });

  it("keeps a fork's placeholders when the thread's own session is replaced", () => {
    const store = open();
    store.putThreadSession(newSession());
    store.putThreadFork({
      ...newSession({ sessionId: "session-fork" }),
      actor: "microsoft:colleague",
    });
    store.putTurnPlaceholder(threadKey, "session-1", "m-1", "reply-1");
    store.putTurnPlaceholder(threadKey, "session-fork", "fm-1", "fork-reply-1");
    store.putThreadSession(newSession({ sessionId: "session-2" }));
    expect(store.getTurnPlaceholder(threadKey, "m-1")).toBeNull();
    expect(store.getTurnPlaceholder(threadKey, "fm-1")).toBe("fork-reply-1");
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

  it("adds the placeholder session column to a database created before it existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "teams-bot-state-"));
    dirs.push(dir);
    const legacy = new DatabaseSync(join(dir, STATE_FILE_NAME));
    legacy.exec(
      `CREATE TABLE turn_placeholders (
         thread_key TEXT NOT NULL, message_id TEXT NOT NULL,
         progress_activity_id TEXT NOT NULL, created_at INTEGER NOT NULL,
         PRIMARY KEY (thread_key, message_id));
       INSERT INTO turn_placeholders VALUES ('${threadKey}', 'm-old', 'reply-old', 1);`
    );
    legacy.close();
    const store = TeamsStateStore.open(dir);
    stores.push(store);
    store.putThreadSession(newSession());
    store.putTurnPlaceholder(threadKey, "session-1", "m-1", "reply-1");
    expect(store.getTurnPlaceholder(threadKey, "m-1")).toBe("reply-1");
    // A row from before the column belongs to the thread's own session and goes with it.
    expect(store.getTurnPlaceholder(threadKey, "m-old")).toBeNull();
  });

  it("persists to a file under the state directory and survives reopening", () => {
    const dir = mkdtempSync(join(tmpdir(), "teams-bot-state-"));
    dirs.push(dir);
    const first = TeamsStateStore.open(join(dir, "nested"));
    first.putThreadSession(newSession());
    first.close();
    const second = TeamsStateStore.open(join(dir, "nested"));
    stores.push(second);
    expect(second.getThreadSession(threadKey)?.sessionId).toBe("session-1");
    expect(STATE_FILE_NAME).toBe("teams-bot.sqlite");
  });
});
