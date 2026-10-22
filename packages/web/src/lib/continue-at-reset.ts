import {
  continueAtResetResponseSchema,
  NO_FUTURE_RESET,
} from "@open-inspect/shared/types/session-api";
import { browserApiFetch } from "@/lib/browser-api-fetch";

export type ContinueAtResetResult =
  { ok: true; scheduledContinueAtMs: number | null } | { ok: false; message: string };

export const NO_FUTURE_RESET_MESSAGE =
  "This limit has no reset time ahead. Continue now or fork the session instead.";

async function failureMessage(response: Response, fallback: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object") return fallback;
  if ("code" in body && body.code === NO_FUTURE_RESET) return NO_FUTURE_RESET_MESSAGE;
  if ("error" in body && typeof body.error === "string") return body.error;
  return fallback;
}

async function requestContinueAtReset(
  sessionId: string,
  method: "POST" | "DELETE",
  fallback: string
): Promise<ContinueAtResetResult> {
  try {
    const response = await browserApiFetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/continue-at-reset`,
      { method }
    );
    if (!response.ok) return { ok: false, message: await failureMessage(response, fallback) };
    const parsed = continueAtResetResponseSchema.safeParse(await response.json());
    return parsed.success
      ? { ok: true, scheduledContinueAtMs: parsed.data.scheduledContinueAtMs }
      : { ok: false, message: fallback };
  } catch {
    return { ok: false, message: fallback };
  }
}

/** Opts the session in to continuing on its own once the limit resets. */
export function scheduleContinueAtReset(sessionId: string) {
  return requestContinueAtReset(sessionId, "POST", "The continue could not be scheduled.");
}

export function cancelContinueAtReset(sessionId: string) {
  return requestContinueAtReset(
    sessionId,
    "DELETE",
    "The scheduled continue could not be cancelled."
  );
}
