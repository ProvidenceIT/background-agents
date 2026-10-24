import { ApprovalRequestStore } from "../db/approval-requests";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";

/**
 * Move pending approval requests past their `expiresAt` to `expired`. No handler runs for an
 * expired request. Idempotent, so a slot that fires twice costs one extra update.
 */
export async function runApprovalExpiryJob(
  db: SqlDatabase,
  log: Logger,
  nowMs: number
): Promise<void> {
  const expired = await new ApprovalRequestStore(db).expireDue(nowMs);
  if (expired > 0) log.info("approval.expired", { requests: expired });
}
