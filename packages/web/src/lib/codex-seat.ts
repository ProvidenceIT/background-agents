import useSWR from "swr";
import {
  authHomeSeatResponseSchema,
  type AuthHomeSeat,
} from "@open-inspect/shared/types/auth-homes";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { useAuthSession } from "@/lib/auth-session";

/**
 * The Codex seat of the signed-in user's subscription home: one running
 * Codex session per home, the rest wait in order (the control plane's
 * fenced lease). Composers read it to say why a Codex session has not
 * started yet.
 */
export const CODEX_SEAT_API_PATH = "/api/me/auth-home/lease";
/** A waiting session asks for the seat again every 30 s; the notice follows at the same pace. */
const CODEX_SEAT_REFRESH_MS = 30_000;

async function fetchCodexSeat(): Promise<AuthHomeSeat | null> {
  const response = await browserApiFetch(CODEX_SEAT_API_PATH);
  // No home registered: there is no seat to wait for.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to load the Codex seat (${response.status})`);
  return authHomeSeatResponseSchema.parse(await response.json()).seat;
}

export function useCodexSeat(harness: HarnessId | undefined) {
  const { data: session } = useAuthSession();
  const userId = session?.user.id;
  const result = useSWR(
    userId && harness === "codex" ? [CODEX_SEAT_API_PATH, userId] : null,
    fetchCodexSeat,
    { refreshInterval: CODEX_SEAT_REFRESH_MS, keepPreviousData: false }
  );
  return result.data ?? null;
}

/**
 * What a composer says about the seat, or null when there is nothing to say.
 * With a session id, it speaks for that session; without one (a new
 * session), it says whether a new Codex session would have to wait.
 */
export function codexSeatNotice(seat: AuthHomeSeat | null, sessionId?: string): string | null {
  if (!seat) return null;
  if (sessionId) {
    const waiting = seat.waiting.find((waiter) => waiter.sessionId === sessionId);
    if (waiting) {
      return seat.holder?.fencing
        ? "Waiting for your Codex seat: the previous Codex session stopped responding and is being shut down."
        : `Waiting for your Codex seat (position ${waiting.position}).`;
    }
    return null;
  }
  if (!seat.holder) return null;
  return seat.holder.mine
    ? "Your Codex seat is in use by another of your sessions; a new Codex session waits for it."
    : "Your Codex seat is in use by a colleague's session; a new Codex session waits for it.";
}
