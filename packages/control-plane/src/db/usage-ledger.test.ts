import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { UsageLedgerStore, type SettledTurn } from "./usage-ledger";

const NOW = Date.UTC(2026, 9, 22, 12);

describe("UsageLedgerStore.slotsForHome", () => {
  let db: NodeSqlDatabase;
  let ledger: UsageLedgerStore;

  beforeEach(async () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    db = createNodeSqlDatabase(sqlite);
    ledger = new UsageLedgerStore(db);
    await seedSession("session-a1", "home-alice");
    await seedSession("session-a2", "home-alice");
    await seedSession("session-b1", "home-bob");
    await seedSession("session-none", null);
  });
  afterEach(() => db.close());

  function seedSession(id: string, homeId: string | null) {
    return db
      .prepare(
        "INSERT INTO sessions (id, user_id, auth_home_id, created_at, updated_at) VALUES (?, 'alice', ?, 1, 1)"
      )
      .bind(id, homeId)
      .run();
  }

  function turn(messageId: string, overrides: Partial<SettledTurn>): SettledTurn {
    return {
      messageId,
      sessionId: "session-a1",
      userId: "alice",
      repoExternalId: null,
      harness: "claude",
      model: "anthropic/claude-sonnet-4-5",
      costUsd: 0,
      inputTokens: null,
      outputTokens: null,
      subscriptionSlot: null,
      settledAt: NOW,
      ...overrides,
    };
  }

  it("lists the slots every session of the home spent, in numeric name order", async () => {
    await ledger.recordTurn(turn("m1", { subscriptionSlot: "claude-10", settledAt: NOW }));
    await ledger.recordTurn(turn("m2", { subscriptionSlot: "claude-2", settledAt: NOW + 1 }));
    await ledger.recordTurn(
      turn("m3", { sessionId: "session-a2", subscriptionSlot: "claude-2", settledAt: NOW + 5 })
    );
    await ledger.recordTurn(
      turn("m4", { sessionId: "session-a2", subscriptionSlot: "claude-1", settledAt: NOW + 2 })
    );
    await ledger.recordTurn(turn("m5", { subscriptionSlot: null }));
    await ledger.recordTurn(
      turn("m6", { sessionId: "session-b1", subscriptionSlot: "claude-7", settledAt: NOW })
    );
    await ledger.recordTurn(
      turn("m7", { sessionId: "session-none", subscriptionSlot: "claude-8", settledAt: NOW })
    );

    expect(await ledger.slotsForHome("home-alice")).toEqual([
      { slot: "claude-1", lastUsedAt: NOW + 2 },
      { slot: "claude-2", lastUsedAt: NOW + 5 },
      { slot: "claude-10", lastUsedAt: NOW },
    ]);
    expect(await ledger.slotsForHome("home-bob")).toEqual([{ slot: "claude-7", lastUsedAt: NOW }]);
    expect(await ledger.slotsForHome("home-nobody")).toEqual([]);
  });

  it("keeps Claude and Codex pool slots apart", async () => {
    await ledger.recordTurn(turn("m1", { subscriptionSlot: "claude-1" }));
    await ledger.recordTurn(turn("m2", { harness: null, subscriptionSlot: "claude-3" }));
    await ledger.recordTurn(turn("m3", { harness: "codex", subscriptionSlot: "codex-1" }));

    expect(await ledger.slotsForHome("home-alice", { except: "codex" })).toEqual([
      { slot: "claude-1", lastUsedAt: NOW },
      { slot: "claude-3", lastUsedAt: NOW },
    ]);
    expect(await ledger.slotsForHome("home-alice", { only: "codex" })).toEqual([
      { slot: "codex-1", lastUsedAt: NOW },
    ]);
  });

  it("caps the list at 32 slots, keeping the most recently used", async () => {
    for (let i = 1; i <= 33; i++) {
      await ledger.recordTurn(
        turn(`m${i}`, { subscriptionSlot: `claude-${i}`, settledAt: NOW + i })
      );
    }

    const slots = await ledger.slotsForHome("home-alice");
    expect(slots).toHaveLength(32);
    expect(slots[0]).toEqual({ slot: "claude-2", lastUsedAt: NOW + 2 });
    expect(slots[31]).toEqual({ slot: "claude-33", lastUsedAt: NOW + 33 });
  });
});
