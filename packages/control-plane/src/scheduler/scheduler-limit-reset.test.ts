/**
 * Scheduler behavior when an automation run's session stops at a usage limit or
 * on an overloaded provider, against the real migrations and AutomationStore SQL.
 */

import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import {
  AutomationStore,
  type AutomationRow,
  type InvocationOverlapScope,
} from "../db/automation-store";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import type { Env } from "../types";
import {
  AutomationTriggerBlockedError,
  Scheduler,
  type AutomationRunCompletion,
  type AutomationRunResumePort,
} from "./scheduler";

const MIGRATIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../terraform/d1/migrations"
);
const NOW = 1_790_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

const automation: AutomationRow = {
  id: "auto-1",
  name: "Nightly triage",
  instructions: "Triage new issues",
  trigger_type: "schedule",
  schedule_cron: "0 * * * *",
  schedule_tz: "UTC",
  model: "anthropic/claude-sonnet-4-6",
  harness: "opencode",
  reasoning_effort: null,
  enabled: 1,
  next_run_at: null,
  consecutive_failures: 0,
  background_consent_at: null,
  created_by: "user-1",
  user_id: "user-1",
  owner_team_id: null,
  created_at: 1000,
  updated_at: 1000,
  deleted_at: null,
  event_type: null,
  trigger_config: null,
  trigger_auth_data: null,
};

describe("Scheduler.runComplete at a usage limit", () => {
  let db: NodeSqlDatabase;
  let store: AutomationStore;
  let scheduler: Scheduler;
  let resume: AutomationRunResumePort & { scheduleContinue: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(sqlite, MIGRATIONS);
    db = createNodeSqlDatabase(sqlite);
    store = new AutomationStore(db);
    await store.create(automation);
    const env = { DB: db, DEPLOYMENT_NAME: "test" } as unknown as Env;
    scheduler = new Scheduler(db, env, createTestBackgroundTasks());
    resume = { scheduleContinue: vi.fn(async () => true) };
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  /** One firing with one running child, as the launch leaves it. */
  async function seedRunningRun(
    n: number,
    concurrencyKey: string | null = null,
    overlapScope: InvocationOverlapScope = { kind: "concurrencyKey", concurrencyKey: `key-${n}` }
  ): Promise<string> {
    const runId = `run-${n}`;
    await store.insertInvocationGuarded({
      invocation: {
        id: `inv-${n}`,
        automation_id: automation.id,
        source: "manual",
        scheduled_at: null,
        trigger_key: null,
        concurrency_key: concurrencyKey,
        trigger_metadata: null,
        skip_reason: null,
        failure_counted_at: null,
        created_at: NOW + n,
        updated_at: NOW + n,
      },
      children: [
        {
          id: runId,
          automation_id: automation.id,
          invocation_id: `inv-${n}`,
          session_id: `sess-${n}`,
          status: "running",
          skip_reason: null,
          failure_reason: null,
          scheduled_at: NOW,
          started_at: NOW,
          execution_deadline_at: NOW + HOUR_MS,
          resume_at: null,
          outcome: null,
          completed_at: null,
          created_at: NOW + n,
          repo_owner: null,
          repo_name: null,
          repo_id: null,
          base_branch: null,
          environment_id: null,
        },
      ],
      overlapScope,
    });
    // The insert leaves the deadline to the launch claim; stamp the launch budget.
    await store.setRunExecutionDeadline(runId, NOW + HOUR_MS);
    return runId;
  }

  function completion(runId: string, overrides: Partial<AutomationRunCompletion>) {
    return {
      automationId: automation.id,
      runId,
      sessionId: `sess-${runId}`,
      messageId: `msg-${runId}`,
      automationName: automation.name,
      success: false,
      error: "You've hit your limit",
      ...overrides,
    } satisfies AutomationRunCompletion;
  }

  async function runRow(runId: string) {
    return store.getRunById(automation.id, runId);
  }

  it("does not auto-pause after three usage-limited runs, and each schedules a continue at its reset", async () => {
    const resets = [NOW + HOUR_MS, NOW + 2 * HOUR_MS, NOW + 3 * HOUR_MS];

    for (const [index, resetsAtMs] of resets.entries()) {
      const runId = await seedRunningRun(index + 1);
      await scheduler.runComplete(
        completion(runId, { outcome: "usage_limited", resetsAtMs }),
        resume
      );
    }

    const after = await store.getById(automation.id);
    expect(after?.enabled).toBe(1);
    expect(after?.consecutive_failures).toBe(0);
    expect(resume.scheduleContinue.mock.calls.map(([request]) => request)).toEqual([
      {
        messageId: "msg-run-1",
        atMs: NOW + HOUR_MS + 60_000,
        callbackContext: {
          source: "automation",
          automationId: "auto-1",
          runId: "run-1",
          automationName: "Nightly triage",
        },
      },
      {
        messageId: "msg-run-2",
        atMs: NOW + 2 * HOUR_MS + 60_000,
        callbackContext: {
          source: "automation",
          automationId: "auto-1",
          runId: "run-2",
          automationName: "Nightly triage",
        },
      },
      {
        messageId: "msg-run-3",
        atMs: NOW + 3 * HOUR_MS + 60_000,
        callbackContext: {
          source: "automation",
          automationId: "auto-1",
          runId: "run-3",
          automationName: "Nightly triage",
        },
      },
    ]);
    expect(await runRow("run-2")).toMatchObject({
      status: "waiting_for_reset",
      outcome: "usage_limited",
      resume_at: NOW + 2 * HOUR_MS + 60_000,
      // Resumed turn gets the budget the run was launched with.
      execution_deadline_at: NOW + 2 * HOUR_MS + 60_000 + HOUR_MS,
      completed_at: null,
    });
    const { invocations } = await store.listInvocations(automation.id, { limit: 10, offset: 0 });
    expect(invocations.map((invocation) => invocation.status)).toEqual([
      "waiting_for_reset",
      "waiting_for_reset",
      "waiting_for_reset",
    ]);
  });

  it("completes a waiting run when its resumed turn succeeds", async () => {
    const runId = await seedRunningRun(1);
    await scheduler.runComplete(
      completion(runId, { outcome: "usage_limited", resetsAtMs: NOW + HOUR_MS }),
      resume
    );

    await scheduler.runComplete(completion(runId, { success: true, error: undefined }), resume);

    expect(await runRow(runId)).toMatchObject({ status: "completed", completed_at: NOW });
  });

  it("fails without a strike when the limit gives no future reset", async () => {
    const runId = await seedRunningRun(1);

    await scheduler.runComplete(
      completion(runId, { outcome: "usage_limited", resetsAtMs: null }),
      resume
    );

    expect(resume.scheduleContinue).not.toHaveBeenCalled();
    expect(await runRow(runId)).toMatchObject({
      status: "failed",
      outcome: "usage_limited",
      failure_reason: "You've hit your limit",
    });
    expect((await store.getById(automation.id))?.consecutive_failures).toBe(0);
  });

  it("fails when the session cannot schedule the continue", async () => {
    resume.scheduleContinue.mockResolvedValue(false);
    const runId = await seedRunningRun(1);

    await scheduler.runComplete(
      completion(runId, { outcome: "usage_limited", resetsAtMs: NOW + HOUR_MS }),
      resume
    );

    expect(await runRow(runId)).toMatchObject({ status: "failed", outcome: "usage_limited" });
  });

  it("still strikes an ordinary failure of a resumed turn", async () => {
    const runId = await seedRunningRun(1);
    await scheduler.runComplete(
      completion(runId, { outcome: "usage_limited", resetsAtMs: NOW + HOUR_MS }),
      resume
    );

    await scheduler.runComplete(
      completion(runId, { outcome: null, error: "Tests failed" }),
      resume
    );

    expect(await runRow(runId)).toMatchObject({
      status: "failed",
      outcome: null,
      failure_reason: "Tests failed",
    });
    expect((await store.getById(automation.id))?.consecutive_failures).toBe(1);
  });

  it("retries an overloaded run with exponential backoff and stops after three retries", async () => {
    const runId = await seedRunningRun(1);
    const overloaded = (overloadRetries: number) =>
      completion(runId, {
        outcome: "overloaded",
        error: "API Error: 529 Overloaded",
        overloadRetries,
      });

    for (const retries of [0, 1, 2, 3]) {
      await scheduler.runComplete(overloaded(retries), resume);
    }

    expect(
      resume.scheduleContinue.mock.calls.map(([request]) => [
        request.atMs - NOW,
        request.callbackContext.overloadRetries,
      ])
    ).toEqual([
      [60_000, 1],
      [120_000, 2],
      [240_000, 3],
    ]);
    expect(await runRow(runId)).toMatchObject({
      status: "failed",
      outcome: "overloaded",
      failure_reason: "API Error: 529 Overloaded",
    });
    const after = await store.getById(automation.id);
    expect(after?.consecutive_failures).toBe(0);
    expect(after?.enabled).toBe(1);
  });

  it("fails a waiting run whose resumed turn never reports back by its deadline", async () => {
    const runId = await seedRunningRun(1);
    await scheduler.runComplete(
      completion(runId, { outcome: "usage_limited", resetsAtMs: NOW + HOUR_MS }),
      resume
    );
    const waiting = await store.getWaitingRunsPastDeadline(NOW + 2 * HOUR_MS + 60_001, 10);
    expect(waiting.map((run) => run.id)).toEqual([runId]);

    await store.bulkFailWaitingRuns([runId], "execution_timeout", NOW + 3 * HOUR_MS);

    expect(await runRow(runId)).toMatchObject({
      status: "failed",
      failure_reason: "execution_timeout",
    });
  });

  describe("a waiting run holds the active slot", () => {
    async function seedWaitingRun(concurrencyKey: string | null = null): Promise<string> {
      const runId = await seedRunningRun(1, concurrencyKey);
      await scheduler.runComplete(
        completion(runId, { outcome: "usage_limited", resetsAtMs: NOW + HOUR_MS }),
        resume
      );
      expect((await runRow(runId))?.status).toBe("waiting_for_reset");
      return runId;
    }

    it("skips a scheduled firing during the wait as concurrent_run_active", async () => {
      await seedWaitingRun();
      await db
        .prepare("UPDATE automations SET next_run_at = ? WHERE id = ?")
        .bind(NOW - 1, automation.id)
        .run();

      await scheduler.tick();

      const { invocations } = await store.listInvocations(automation.id, { limit: 10, offset: 0 });
      expect(invocations.map((invocation) => [invocation.status, invocation.skipReason])).toEqual([
        // The seeded run was created at NOW + 1; the skip at NOW.
        ["waiting_for_reset", null],
        ["skipped", "concurrent_run_active"],
      ]);
    });

    it("blocks a manual trigger during the wait", async () => {
      await seedWaitingRun();

      await expect(scheduler.trigger(automation.id, "user-1")).rejects.toBeInstanceOf(
        AutomationTriggerBlockedError
      );
    });

    it("blocks a same-key event and the guarded insert during the wait", async () => {
      const runId = await seedWaitingRun("pr-42");

      expect((await store.getActiveRunForKey(automation.id, "pr-42"))?.id).toBe(runId);
      expect(await store.getActiveRunForKey(automation.id, "pr-43")).toBeNull();
      expect((await store.getActiveRunForAutomation(automation.id))?.id).toBe(runId);
      // The atomic insert re-applies the same predicate, so a racing firing loses too.
      await seedRunningRun(2, "pr-42", { kind: "concurrencyKey", concurrencyKey: "pr-42" });
      expect(await runRow("run-2")).toBeNull();
    });
  });
});
