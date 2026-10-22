"use client";

import { useEffect, useState } from "react";
import type { TurnLimit } from "@open-inspect/shared/types/sandbox-events";
import { describeScheduledContinue, describeTurnLimit, turnLimitSummary } from "@/lib/turn-limit";

/** How often the reset countdown re-renders; it shows whole minutes. */
export const LIMIT_COUNTDOWN_TICK_MS = 15_000;

export type ContinueAfterLimitResult = { ok: true } | { ok: false; message: string };

const BUTTON_CLASS =
  "rounded-sm border border-border bg-background px-2.5 py-1 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";

type BannerAction = "continue" | "schedule" | "cancel";

const ACTION_FAILURES: Record<BannerAction, string> = {
  continue: "The continue prompt could not be sent.",
  schedule: "The continue could not be scheduled.",
  cancel: "The scheduled continue could not be cancelled.",
};

interface LimitReachedBannerProps {
  limit: TurnLimit | null | undefined;
  /** Sends the continue prompt; leave unset when the viewer cannot send prompts now. */
  onContinue?: () => Promise<ContinueAfterLimitResult>;
  /** Opens the fork dialog; leave unset when the viewer cannot fork. */
  onFork?: () => void;
  /** When the opted-in continue is due (epoch ms); null or absent when none is scheduled. */
  scheduledContinueAtMs?: number | null;
  /** Schedules the continue for after the reset; leave unset when the viewer cannot collaborate. */
  onScheduleContinue?: () => Promise<ContinueAfterLimitResult>;
  /** Cancels the scheduled continue; leave unset when the viewer cannot collaborate. */
  onCancelScheduledContinue?: () => Promise<ContinueAfterLimitResult>;
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
  scheduledContinueAtMs = null,
  onScheduleContinue,
  onCancelScheduledContinue,
  isProcessing,
  hasQueuedPrompt = false,
}: LimitReachedBannerProps & { limit: TurnLimit }) {
  const nowMs = useNowMs(limit.resetsAtMs);
  const [pending, setPending] = useState<BannerAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const summary = turnLimitSummary(limit);
  const reset = nowMs === null ? null : describeTurnLimit(limit, nowMs).reset;
  const scheduled =
    nowMs === null || scheduledContinueAtMs === null
      ? null
      : describeScheduledContinue(scheduledContinueAtMs, nowMs);
  const resetAhead = nowMs !== null && limit.resetsAtMs !== null && limit.resetsAtMs > nowMs;

  const run = async (action: BannerAction, handler?: () => Promise<ContinueAfterLimitResult>) => {
    if (!handler || pending) return;
    setPending(action);
    setActionError(null);
    try {
      const result = await handler();
      if (!result.ok) setActionError(result.message);
    } catch {
      setActionError(ACTION_FAILURES[action]);
    } finally {
      setPending(null);
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
        {scheduled && <span className="font-medium"> {scheduled}</span>}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={BUTTON_CLASS}
          disabled={!onContinue || isProcessing || pending !== null || hasQueuedPrompt}
          onClick={() => void run("continue", onContinue)}
        >
          {pending === "continue" ? "Sending…" : hasQueuedPrompt ? "Queued" : "Continue"}
        </button>
        {scheduled
          ? onCancelScheduledContinue && (
              <button
                type="button"
                className={BUTTON_CLASS}
                disabled={pending !== null}
                aria-label="Cancel the scheduled continue"
                onClick={() => void run("cancel", onCancelScheduledContinue)}
              >
                {pending === "cancel" ? "Cancelling…" : "Cancel"}
              </button>
            )
          : onScheduleContinue &&
            resetAhead && (
              <button
                type="button"
                className={BUTTON_CLASS}
                disabled={pending !== null}
                onClick={() => void run("schedule", onScheduleContinue)}
              >
                {pending === "schedule" ? "Scheduling…" : "Continue when it resets"}
              </button>
            )}
        <button
          type="button"
          className={BUTTON_CLASS}
          disabled={!onFork}
          aria-haspopup="dialog"
          onClick={onFork}
        >
          Fork…
        </button>
      </div>
      {actionError && (
        <p role="alert" className="w-full text-sm text-destructive">
          {actionError}
        </p>
      )}
    </section>
  );
}
