"use client";

import { useEffect, useState } from "react";
import type { TurnLimit } from "@open-inspect/shared/types/sandbox-events";
import { describeTurnLimit, turnLimitSummary } from "@/lib/turn-limit";

/** How often the reset countdown re-renders; it shows whole minutes. */
export const LIMIT_COUNTDOWN_TICK_MS = 15_000;

export type ContinueAfterLimitResult = { ok: true } | { ok: false; message: string };

interface LimitReachedBannerProps {
  limit: TurnLimit | null | undefined;
  /** Sends the continue prompt; leave unset when the viewer cannot send prompts now. */
  onContinue?: () => Promise<ContinueAfterLimitResult>;
  /** Opens the fork dialog; leave unset when the viewer cannot fork. */
  onFork?: () => void;
  isProcessing: boolean;
  /**
   * A prompt waits in the queue for the sandbox; it clears the limit once it
   * runs, so another Continue would only queue a duplicate.
   */
  hasQueuedPrompt?: boolean;
}

export function LimitReachedBanner({ limit, ...props }: LimitReachedBannerProps) {
  return (
    <>
      {/* Mounted empty before any limit: screen readers announce changes inside an existing live
          region, not a region inserted with its text already in it. */}
      <p role="status" className="sr-only">
        {limit ? `${turnLimitSummary(limit)} The conversation and workspace are saved.` : ""}
      </p>
      {/* A new limit gets fresh pending/error state. */}
      {limit && (
        <LimitBanner key={`${limit.window}:${limit.resetsAtMs}`} limit={limit} {...props} />
      )}
    </>
  );
}

/**
 * The clock the countdown reads; null until mounted, so the server render (its own clock and
 * time zone) never disagrees with the browser's during hydration.
 */
function useNowMs(resetsAtMs: number | null): number | null {
  const [nowMs, setNowMs] = useState<number | null>(null);
  const counting = nowMs === null || (resetsAtMs !== null && nowMs < resetsAtMs);
  useEffect(() => {
    if (!counting) return;
    setNowMs(Date.now());
    const interval = setInterval(() => setNowMs(Date.now()), LIMIT_COUNTDOWN_TICK_MS);
    return () => clearInterval(interval);
  }, [counting]);
  return nowMs;
}

function LimitBanner({
  limit,
  onContinue,
  onFork,
  isProcessing,
  hasQueuedPrompt = false,
}: LimitReachedBannerProps & { limit: TurnLimit }) {
  const nowMs = useNowMs(limit.resetsAtMs);
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);
  const summary = turnLimitSummary(limit);
  const reset = nowMs === null ? null : describeTurnLimit(limit, nowMs).reset;

  const handleContinue = async () => {
    if (!onContinue || continuing) return;
    setContinuing(true);
    setContinueError(null);
    try {
      const result = await onContinue();
      if (!result.ok) setContinueError(result.message);
    } catch {
      setContinueError("The continue prompt could not be sent.");
    } finally {
      setContinuing(false);
    }
  };

  return (
    <section
      aria-label="Subscription limit reached"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-warning/40 bg-warning-muted px-4 py-2.5 text-sm text-foreground"
    >
      <p className="min-w-0 flex-1">
        <span className="font-medium">{summary}</span>
        {reset && <> {reset}</>} The conversation and workspace are saved.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded-sm border border-border bg-background px-2.5 py-1 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
          disabled={!onContinue || isProcessing || continuing || hasQueuedPrompt}
          onClick={() => void handleContinue()}
        >
          {continuing ? "Sending…" : hasQueuedPrompt ? "Queued" : "Continue"}
        </button>
        <button
          type="button"
          className="rounded-sm border border-border bg-background px-2.5 py-1 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
          disabled={!onFork}
          aria-haspopup="dialog"
          onClick={onFork}
        >
          Fork…
        </button>
      </div>
      {continueError && (
        <p role="alert" className="w-full text-sm text-destructive">
          {continueError}
        </p>
      )}
    </section>
  );
}
