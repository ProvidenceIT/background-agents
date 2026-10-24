import type { HarnessId } from "@open-inspect/shared/harnesses";
import { UsageLedgerStore, type HomeSubscriptionSlot } from "../db/usage-ledger";
import type { SqlDatabase } from "../db/sql-database";

/** The harness whose pool a fork may pin a slot of; the Codex seat picks its own. */
export const PINNABLE_SLOT_HARNESS: HarnessId = "claude";

/**
 * The pool slots a session on `harness` bound to `homeId` may prefer: the Claude
 * slots the home's settled turns spent, or none for another harness or no home.
 */
export async function pinnableSubscriptionSlots(
  db: SqlDatabase,
  harness: HarnessId,
  homeId: string | null
): Promise<HomeSubscriptionSlot[]> {
  if (harness !== PINNABLE_SLOT_HARNESS || !homeId) return [];
  return new UsageLedgerStore(db).slotsForHome(homeId, {
    only: PINNABLE_SLOT_HARNESS,
    orUnrecorded: true,
  });
}
