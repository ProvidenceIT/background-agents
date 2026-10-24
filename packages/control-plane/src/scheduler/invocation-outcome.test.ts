import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutomationStore } from "../db/automation-store";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import {
  classifyRunFailure,
  NON_STRIKE_OUTCOMES,
  overloadedRetryDelayMs,
  type AutomationRunOutcome,
} from "./invocation-outcome";

const MIGRATIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../terraform/d1/migrations"
);

describe("NON_STRIKE_OUTCOMES", () => {
  let db: NodeSqlDatabase;
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    applyMigrations(sqlite, MIGRATIONS);
    sqlite.exec(
      `INSERT INTO automations (id, name, instructions, trigger_type, model, created_by, created_at, updated_at)
       VALUES ('auto-1', 'Nightly', 'Do it', 'schedule', 'anthropic/claude-sonnet-4-6', 'user-1', 1, 1)`
    );
    db = createNodeSqlDatabase(sqlite);
  });

  afterEach(() => db.close());

  function seedFailedRun(invocationId: string, outcome: AutomationRunOutcome | null): void {
    sqlite.exec(
      `INSERT INTO automation_invocations (id, automation_id, source, created_at, updated_at)
       VALUES ('${invocationId}', 'auto-1', 'manual', 1, 1)`
    );
    sqlite
      .prepare(
        `INSERT INTO automation_runs (id, automation_id, invocation_id, status, failure_reason,
           outcome, scheduled_at, created_at, completed_at)
         VALUES (?, 'auto-1', ?, 'failed', 'stopped', ?, 1, 1, 2)`
      )
      .run(`run-${invocationId}`, invocationId, outcome);
  }

  it("holds the usage-limit and overloaded outcomes", () => {
    expect([...NON_STRIKE_OUTCOMES]).toEqual(["usage_limited", "overloaded"]);
  });

  it.each([...NON_STRIKE_OUTCOMES])(
    "excludes a %s failure from the strike count",
    async (outcome) => {
      seedFailedRun("inv-1", outcome);
      const store = new AutomationStore(db);

      expect(await store.getInvocationRunAggregate("inv-1")).toMatchObject({
        failed: 1,
        strikeFailed: 0,
      });
      expect(await store.getUncountedFailedInvocations(0, 10)).toEqual([]);
    }
  );

  it("counts an ordinary failure as a strike", async () => {
    seedFailedRun("inv-1", null);
    const store = new AutomationStore(db);

    expect(await store.getInvocationRunAggregate("inv-1")).toMatchObject({
      failed: 1,
      strikeFailed: 1,
    });
    expect((await store.getUncountedFailedInvocations(0, 10)).map((row) => row.id)).toEqual([
      "inv-1",
    ]);
  });
});

describe("classifyRunFailure", () => {
  it("classifies a turn the provider refused for a usage limit", () => {
    expect(
      classifyRunFailure({
        error: "You've hit your limit",
        limit: {
          kind: "subscription_limit",
          window: "five_hour",
          resetsAtMs: null,
          subscriptionSlot: null,
          harness: "claude",
        },
      })
    ).toBe("usage_limited");
  });

  it.each([
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    "Anthropic is overloaded, try again later",
  ])("classifies %s as overloaded", (error) => {
    expect(classifyRunFailure({ error })).toBe("overloaded");
  });

  it("leaves an ordinary failure unclassified", () => {
    expect(classifyRunFailure({ error: "Tests failed: 15290 assertions" })).toBeNull();
    expect(classifyRunFailure({})).toBeNull();
  });
});

describe("overloadedRetryDelayMs", () => {
  it("doubles from one minute and stops after three retries", () => {
    expect([0, 1, 2, 3].map(overloadedRetryDelayMs)).toEqual([60_000, 120_000, 240_000, null]);
  });
});
