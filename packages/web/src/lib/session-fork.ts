import type { HarnessId } from "@open-inspect/shared/harnesses";
import {
  forkHandoffResponseSchema,
  forkSessionResponseSchema,
  forkSubscriptionSlotsResponseSchema,
  SUBSCRIPTION_SLOT_UNAVAILABLE,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type ForkSubscriptionSlot,
} from "@open-inspect/shared/types/session-api";
import { browserApiFetch } from "@/lib/browser-api-fetch";

export type ForkResult<T> = { ok: true; value: T } | { ok: false; message: string };

async function errorMessage(
  response: Response,
  fallback: string,
  messagesByCode: Record<string, string> = {}
): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object") return fallback;
  if ("code" in body && typeof body.code === "string" && messagesByCode[body.code]) {
    return messagesByCode[body.code];
  }
  if ("error" in body && typeof body.error === "string") return body.error;
  return fallback;
}

function forkPath(sessionId: string) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/fork` as const;
}

export async function fetchForkHandoff(sessionId: string): Promise<ForkResult<string>> {
  const fallback = "The handoff draft could not be loaded.";
  try {
    const response = await browserApiFetch(`${forkPath(sessionId)}/handoff`);
    if (!response.ok) return { ok: false, message: await errorMessage(response, fallback) };
    const parsed = forkHandoffResponseSchema.safeParse(await response.json());
    return parsed.success
      ? { ok: true, value: parsed.data.handoff }
      : { ok: false, message: fallback };
  } catch {
    return { ok: false, message: fallback };
  }
}

/** The pool slots a fork on `harness` may prefer, sorted by name. */
export async function fetchForkSubscriptionSlots(
  sessionId: string,
  harness: HarnessId
): Promise<ForkResult<ForkSubscriptionSlot[]>> {
  const fallback = "The subscriptions could not be loaded.";
  try {
    const query = new URLSearchParams({ harness });
    const response = await browserApiFetch(`${forkPath(sessionId)}/subscription-slots?${query}`);
    if (!response.ok) return { ok: false, message: await errorMessage(response, fallback) };
    const parsed = forkSubscriptionSlotsResponseSchema.safeParse(await response.json());
    return parsed.success && parsed.data.harness === harness
      ? { ok: true, value: parsed.data.slots }
      : { ok: false, message: fallback };
  } catch {
    return { ok: false, message: fallback };
  }
}

export const SUBSCRIPTION_SLOT_UNAVAILABLE_MESSAGE =
  "That subscription is not available for this fork. Choose another one or Automatic.";

export async function createSessionFork(
  sessionId: string,
  request: ForkSessionRequest
): Promise<ForkResult<ForkSessionResponse>> {
  const fallback = "The fork could not be created.";
  try {
    const response = await browserApiFetch(forkPath(sessionId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      return {
        ok: false,
        message: await errorMessage(response, fallback, {
          [SUBSCRIPTION_SLOT_UNAVAILABLE]: SUBSCRIPTION_SLOT_UNAVAILABLE_MESSAGE,
        }),
      };
    }
    const parsed = forkSessionResponseSchema.safeParse(await response.json());
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: fallback };
  } catch {
    return { ok: false, message: fallback };
  }
}
