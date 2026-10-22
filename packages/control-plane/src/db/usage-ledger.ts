import { z } from "zod";
import {
  MAX_SESSION_SUBSCRIPTION_SLOTS,
  type SessionSubscriptionSlot,
} from "@open-inspect/shared/types/session-subscription";
import type { UsagePeriodTotals, UsagePeriodWindow } from "@open-inspect/shared/types/usage-quotas";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import type { UsageScope } from "./usage-quotas";

/** One settled turn as the session reports it when `execution_complete` lands. */
export interface SettledTurn {
  messageId: string;
  sessionId: string;
  /** The metered identity of the prompt's author. */
  userId: string;
  repoExternalId: number | null;
  harness: string | null;
  model: string | null;
  costUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** The subscription-home slot the turn spent, as the sandbox reported it. */
  subscriptionSlot: string | null;
  settledAt: number;
}

const totalsRowSchema = z.object({
  turns: z.number(),
  tokens: z.number(),
  cost_usd: z.number(),
});

const homeSlotRowSchema = z.object({
  slot: z.string(),
  last_used_at: z.number(),
});

/** Slot names in numeric order, so `claude-2` sorts before `claude-10`. */
const slotNameCollator = new Intl.Collator("en", { numeric: true });

/** One pool slot a home's settled turns spent, and when it last did. */
export interface HomeSubscriptionSlot {
  slot: string;
  lastUsedAt: number;
}

const slotRowSchema = z.object({
  slot: z.string(),
  turns: z.number(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  last_used_at: z.number(),
});

/** Scope filter over ledger rows; the workspace scope matches every row. */
function scopePredicate(scope: UsageScope): { sql: string; binds: string[] } {
  if (scope.kind === "workspace") return { sql: "", binds: [] };
  const column = scope.kind === "user" ? "user_id" : "team_id";
  return { sql: `AND ${column} = ?`, binds: [scope.id ?? ""] };
}

/**
 * The usage ledger: one row per settled turn in the global store, which is
 * what period quotas are summed over.
 *
 * Idempotent on the message id. The session reports each turn's cumulative
 * cost and token totals, so a completion delivered twice rewrites the row
 * with the same values and the period totals do not move; `settled_at`
 * keeps the first delivery's time so the turn cannot change window.
 */
export class UsageLedgerStore {
  constructor(private readonly db: SqlDatabase) {}

  /** The ledger write, for callers that batch it with other statements. */
  bindRecordTurn(turn: SettledTurn): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO usage_ledger
          (message_id, session_id, user_id, team_id, repo_external_id, harness, model,
           cost_usd, input_tokens, output_tokens, subscription_slot, settled_at)
         SELECT ?, s.id, ?, s.owner_team_id, ?, ?, ?, ?, ?, ?, ?, ? FROM sessions s WHERE s.id = ?
         ON CONFLICT (message_id) DO UPDATE SET
           cost_usd = excluded.cost_usd,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           subscription_slot = COALESCE(excluded.subscription_slot, usage_ledger.subscription_slot)`
      )
      .bind(
        turn.messageId,
        turn.userId,
        turn.repoExternalId,
        turn.harness,
        turn.model,
        turn.costUsd,
        turn.inputTokens,
        turn.outputTokens,
        turn.subscriptionSlot,
        turn.settledAt,
        turn.sessionId
      );
  }

  async recordTurn(turn: SettledTurn): Promise<void> {
    await this.bindRecordTurn(turn).run();
  }

  /** Settled usage of `scope` with `settled_at` inside the window. */
  async sumForScope(scope: UsageScope, window: UsagePeriodWindow): Promise<UsagePeriodTotals> {
    const predicate = scopePredicate(scope);
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS turns,
           COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS tokens,
           COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM usage_ledger
         WHERE settled_at >= ? AND settled_at < ? ${predicate.sql}`
      )
      .bind(window.startAt, window.endAt, ...predicate.binds)
      .first();
    const totals = totalsRowSchema.parse(row);
    return { turns: totals.turns, tokens: totals.tokens, costUsd: totals.cost_usd };
  }

  /**
   * The subscription-home slots a session's settled turns spent, most recent first.
   * `harness.only` keeps the turns of one harness, `harness.except` drops them (turns
   * with no recorded harness are kept by `except`), so a Claude and a Codex pool slot
   * are never listed under each other's provider.
   */
  async slotsForSession(
    sessionId: string,
    harness: { only?: string; except?: string } = {}
  ): Promise<SessionSubscriptionSlot[]> {
    const only = harness.only ?? null;
    const except = harness.except ?? null;
    const { results } = await this.db
      .prepare(
        `SELECT subscription_slot AS slot, COUNT(*) AS turns,
           SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
           MAX(settled_at) AS last_used_at
         FROM usage_ledger
         WHERE session_id = ? AND subscription_slot IS NOT NULL
           AND (? IS NULL OR harness = ?)
           AND (? IS NULL OR harness IS NULL OR harness <> ?)
         GROUP BY subscription_slot
         ORDER BY last_used_at DESC, slot
         LIMIT ?`
      )
      .bind(sessionId, only, only, except, except, MAX_SESSION_SUBSCRIPTION_SLOTS)
      .all();
    return results.map((raw) => {
      const row = slotRowSchema.parse(raw);
      return {
        slot: row.slot,
        turns: row.turns,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        lastUsedAt: row.last_used_at,
      };
    });
  }

  /**
   * The pool slots the settled turns of every session bound to `homeId` spent, sorted
   * by slot name. `harness` splits Claude and Codex slots as in `slotsForSession`. The
   * control plane keeps no slot registry, so a slot appears once a turn has spent it.
   */
  async slotsForHome(
    homeId: string,
    harness: { only?: string; except?: string } = {}
  ): Promise<HomeSubscriptionSlot[]> {
    const only = harness.only ?? null;
    const except = harness.except ?? null;
    const { results } = await this.db
      .prepare(
        `SELECT l.subscription_slot AS slot, MAX(l.settled_at) AS last_used_at
         FROM usage_ledger l
         JOIN sessions s ON s.id = l.session_id
         WHERE s.auth_home_id = ? AND l.subscription_slot IS NOT NULL
           AND (? IS NULL OR l.harness = ?)
           AND (? IS NULL OR l.harness IS NULL OR l.harness <> ?)
         GROUP BY l.subscription_slot
         ORDER BY last_used_at DESC, slot
         LIMIT ?`
      )
      .bind(homeId, only, only, except, except, MAX_SESSION_SUBSCRIPTION_SLOTS)
      .all();
    return results
      .map((raw) => {
        const row = homeSlotRowSchema.parse(raw);
        return { slot: row.slot, lastUsedAt: row.last_used_at };
      })
      .sort((a, b) => slotNameCollator.compare(a.slot, b.slot));
  }
}
