import { useCallback } from "react";
import type { ContinueAfterLimitResult } from "@/components/limit-reached-banner";
import {
  cancelContinueAtReset,
  scheduleContinueAtReset,
  type ContinueAtResetResult,
} from "@/lib/continue-at-reset";

/**
 * Schedule and Cancel for the limit banner. Each answer is applied to the session view at once,
 * so the banner does not wait for the matching broadcast.
 */
export function useContinueAtReset(
  sessionId: string,
  applyScheduledContinue: (scheduledContinueAtMs: number | null) => void
): {
  schedule: () => Promise<ContinueAfterLimitResult>;
  cancel: () => Promise<ContinueAfterLimitResult>;
} {
  const settle = useCallback(
    (result: ContinueAtResetResult): ContinueAfterLimitResult => {
      if (!result.ok) return result;
      applyScheduledContinue(result.scheduledContinueAtMs);
      return { ok: true };
    },
    [applyScheduledContinue]
  );
  const schedule = useCallback(
    async () => settle(await scheduleContinueAtReset(sessionId)),
    [sessionId, settle]
  );
  const cancel = useCallback(
    async () => settle(await cancelContinueAtReset(sessionId)),
    [sessionId, settle]
  );
  return { schedule, cancel };
}
