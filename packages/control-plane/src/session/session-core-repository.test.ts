import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { initSchema } from "./schema";
import { SessionCoreRepository } from "./session-core-repository";

const LIMIT = {
  kind: "subscription_limit",
  window: "seven_day_opus",
  resetsAtMs: null,
  subscriptionSlot: null,
  harness: "claude",
} as const;

describe("SessionCoreRepository fork lineage and turn limit", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  function createRepository(forkedFromSessionId?: string | null) {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const storage = createNodeSqlStorage(db);
    initSchema(storage.sql);
    const repository = new SessionCoreRepository(storage.sql, storage.transactionSync);
    repository.upsertSession({
      id: "do-1",
      sessionName: "session-1",
      title: "Fork me",
      repoOwner: null,
      repoName: null,
      model: "anthropic/claude-sonnet-4-6",
      status: "created",
      forkedFromSessionId,
      createdAt: 1,
      updatedAt: 1,
    });
    return { db, repository };
  }

  it("records the fork source given at init", () => {
    expect(createRepository("source-1").repository.getForkedFromSessionId()).toBe("source-1");
    expect(createRepository().repository.getForkedFromSessionId()).toBeNull();
  });

  it("stores, reads back, and clears the last turn limit", () => {
    const { repository } = createRepository();
    expect(repository.getLastTurnLimit()).toBeNull();

    repository.setLastTurnLimit(LIMIT);
    expect(repository.getLastTurnLimit()).toEqual(LIMIT);

    repository.setLastTurnLimit(null);
    expect(repository.getLastTurnLimit()).toBeNull();
  });

  it("reads a stored limit that no longer parses as no limit", () => {
    const { db, repository } = createRepository();
    db.exec(`UPDATE session SET last_turn_limit = '{"kind":"spend_limit"}'`);
    expect(repository.getLastTurnLimit()).toBeNull();
    db.exec(`UPDATE session SET last_turn_limit = 'not json'`);
    expect(repository.getLastTurnLimit()).toBeNull();
  });
});
