import {
  forkHandoffResponseSchema,
  forkSessionResponseSchema,
  type ForkSessionRequest,
  type ForkSessionResponse,
} from "@open-inspect/shared/types/session-api";
import { browserApiFetch } from "@/lib/browser-api-fetch";

export type ForkResult<T> = { ok: true; value: T } | { ok: false; message: string };

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }
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
    if (!response.ok) return { ok: false, message: await errorMessage(response, fallback) };
    const parsed = forkSessionResponseSchema.safeParse(await response.json());
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: fallback };
  } catch {
    return { ok: false, message: fallback };
  }
}
