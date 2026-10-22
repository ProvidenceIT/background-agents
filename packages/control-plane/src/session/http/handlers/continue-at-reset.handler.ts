import {
  NO_FUTURE_RESET,
  type ContinueAtResetResponse,
} from "@open-inspect/shared/types/session-api";
import { continueAtResetInternalRequestSchema } from "../../contracts";
import { BudgetExhaustedError } from "../../message-queue";
import type { SessionScheduledContinue } from "../../scheduled-continue";

/** The runtime half of POST and DELETE /sessions/:id/continue-at-reset. */
export class ContinueAtResetHandler {
  constructor(
    private readonly scheduledContinue: Pick<SessionScheduledContinue, "schedule" | "cancel">
  ) {}

  async schedule(request: Request): Promise<Response> {
    const body = continueAtResetInternalRequestSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!body.success) return Response.json({ error: "Invalid request" }, { status: 400 });
    const outcome = await this.scheduledContinue.schedule(body.data);
    if (outcome.kind === "no_future_reset") {
      return Response.json(
        { error: "The last turn has no limit that resets later", code: NO_FUTURE_RESET },
        { status: 409 }
      );
    }
    if (outcome.kind === "budget_exhausted") {
      return Response.json(
        { error: new BudgetExhaustedError().message, code: "BUDGET_EXHAUSTED" },
        { status: 409 }
      );
    }
    return Response.json({
      scheduledContinueAtMs: outcome.atMs,
    } satisfies ContinueAtResetResponse);
  }

  cancel(): Response {
    this.scheduledContinue.cancel();
    return Response.json({ scheduledContinueAtMs: null } satisfies ContinueAtResetResponse);
  }
}
