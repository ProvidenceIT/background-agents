import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { SessionNoticeStore, STALE_NOTICE_CLAIM_MS, type NewSessionNotice } from "./notice-store";

const NOTICE: NewSessionNotice = {
  sessionId: "s1",
  revision: 3,
  status: "completed",
  channel: "teams",
  recipientRef: "oid-1",
  reasonCode: "completed",
  payload: '{"x":1}',
  state: "pending",
};

function migratedDatabase(): NodeSqlDatabase {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(
    sqlite,
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
  );
  return createNodeSqlDatabase(sqlite);
}

describe("SessionNoticeStore", () => {
  let db: NodeSqlDatabase;
  let store: SessionNoticeStore;

  beforeEach(() => {
    db = migratedDatabase();
    store = new SessionNoticeStore(db);
  });
  afterEach(() => db.close());

  async function rows() {
    return (
      await db
        .prepare(
          "SELECT id, state, attempts, claimed_at, error_code, delivered_at, next_attempt_at FROM session_notices ORDER BY id"
        )
        .all<Record<string, unknown>>()
    ).results;
  }

  it("records one notice per session revision, channel and recipient", async () => {
    expect(await store.insert(NOTICE, 100)).toBe(true);
    expect(await store.insert(NOTICE, 200)).toBe(false);
    expect(await store.insert({ ...NOTICE, revision: 4 }, 300)).toBe(true);
    expect(await store.insert({ ...NOTICE, channel: "motion" }, 300)).toBe(true);
    expect(await rows()).toHaveLength(3);
  });

  it("claims a due pending notice once, counting the attempt, and never claims shadow rows", async () => {
    await store.insert(NOTICE, 100);
    await store.insert({ ...NOTICE, revision: 4, state: "shadow" }, 100);

    const first = await store.claimDue(100, 10);
    expect(first).toEqual([
      {
        id: 1,
        sessionId: "s1",
        revision: 3,
        channel: "teams",
        recipientRef: "oid-1",
        payload: '{"x":1}',
        attempts: 1,
        createdAt: 100,
      },
    ]);
    expect(await store.claimDue(101, 10)).toEqual([]);
    // A claim that died with its process is taken again.
    expect(await store.claimDue(100 + STALE_NOTICE_CLAIM_MS, 10)).toMatchObject([
      { id: 1, attempts: 2 },
    ]);
  });

  it("settles sent and failed rows, and defers a retry to its next attempt time", async () => {
    await store.insert(NOTICE, 100);
    await store.insert({ ...NOTICE, revision: 4 }, 100);
    await store.insert({ ...NOTICE, revision: 5 }, 100);
    const [a, b, c] = await store.claimDue(100, 10);

    await store.markSent(a!.id, 110);
    await store.markFailed(b!.id, "http_403", 110);
    await store.retryLater(c!.id, "http_503", 5_000, 110);

    expect(await rows()).toEqual([
      expect.objectContaining({ state: "sent", delivered_at: 110, claimed_at: null }),
      expect.objectContaining({ state: "failed", error_code: "http_403", claimed_at: null }),
      expect.objectContaining({
        state: "pending",
        error_code: "http_503",
        claimed_at: null,
        next_attempt_at: 5_000,
      }),
    ]);
    expect(await store.claimDue(4_999, 10)).toEqual([]);
    expect(await store.claimDue(5_000, 10)).toMatchObject([{ id: c!.id, attempts: 2 }]);
  });
});
