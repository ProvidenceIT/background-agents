// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnLimit } from "@open-inspect/shared/types/sandbox-events";
import { LIMIT_COUNTDOWN_TICK_MS, LimitReachedBanner } from "./limit-reached-banner";

const NOW_MS = Date.UTC(2026, 9, 22, 8, 56, 0);
const LIMIT: TurnLimit = {
  kind: "subscription_limit",
  window: "five_hour",
  resetsAtMs: Date.UTC(2026, 9, 22, 9, 0, 0),
  subscriptionSlot: "claude-5",
  harness: "claude",
};

beforeEach(() => {
  process.env.TZ = "UTC";
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW_MS);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("LimitReachedBanner", () => {
  it("shows no banner without a limit", () => {
    render(<LimitReachedBanner limit={null} isProcessing={false} />);
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("announces a new limit through a live region that was already mounted", () => {
    const { rerender } = render(<LimitReachedBanner limit={null} isProcessing={false} />);
    const liveRegion = screen.getByRole("status");

    rerender(<LimitReachedBanner limit={LIMIT} isProcessing={false} />);

    expect(screen.getAllByRole("status")[0]).toBe(liveRegion);
    expect(liveRegion).toHaveTextContent(
      "Claude subscription limit reached (five-hour window, slot claude-5). The conversation and workspace are saved."
    );
  });

  it("says which limit was hit, when it resets and that the work is saved", () => {
    render(<LimitReachedBanner limit={LIMIT} isProcessing={false} />);
    expect(screen.getByRole("region", { name: "Subscription limit reached" })).toHaveTextContent(
      "Claude subscription limit reached (five-hour window, slot claude-5). Resets at 09:00 (in 4 min). The conversation and workspace are saved."
    );
  });

  it("renders the reset clock only in the browser, so hydration cannot disagree", () => {
    const html = renderToString(<LimitReachedBanner limit={LIMIT} isProcessing={false} />);
    expect(html).toContain("Claude subscription limit reached (five-hour window, slot claude-5).");
    expect(html).not.toContain("Resets at");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const onRecoverableError = vi.fn();
    let root: Root | undefined;
    act(() => {
      root = hydrateRoot(container, <LimitReachedBanner limit={LIMIT} isProcessing={false} />, {
        onRecoverableError,
      });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(screen.getByRole("region")).toHaveTextContent("Resets at 09:00 (in 4 min).");
    act(() => root?.unmount());
    container.remove();
  });

  it("counts down and reports the reset once it passes", () => {
    render(<LimitReachedBanner limit={LIMIT} isProcessing={false} />);
    const banner = screen.getByRole("region");
    act(() => vi.advanceTimersByTime(2 * 60_000));
    expect(banner).toHaveTextContent("Resets at 09:00 (in 2 min).");
    for (const liveRegion of screen.getAllByRole("status")) {
      expect(liveRegion).not.toHaveTextContent("Resets at");
    }
    act(() => vi.advanceTimersByTime(2 * 60_000 + LIMIT_COUNTDOWN_TICK_MS));
    expect(banner).toHaveTextContent("The limit has reset.");
    expect(banner).not.toHaveTextContent("Resets at");
  });

  it("sends the continue prompt and reports a rejected send", async () => {
    const onContinue = vi.fn(async () => ({
      ok: false as const,
      message: "Reconnect before sending",
    }));
    render(<LimitReachedBanner limit={LIMIT} isProcessing={false} onContinue={onContinue} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Reconnect before sending");
  });

  it("disables Continue while a turn is processing or without a send handler", () => {
    const { rerender } = render(
      <LimitReachedBanner
        limit={LIMIT}
        isProcessing
        onContinue={async () => ({ ok: true as const })}
      />
    );
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    rerender(<LimitReachedBanner limit={LIMIT} isProcessing={false} />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("keeps Continue disabled while the sent prompt waits in the queue", async () => {
    const onContinue = vi.fn(async () => ({ ok: true as const }));
    const { rerender } = render(
      <LimitReachedBanner limit={LIMIT} isProcessing={false} onContinue={onContinue} />
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    rerender(
      <LimitReachedBanner
        limit={LIMIT}
        isProcessing={false}
        onContinue={onContinue}
        hasQueuedPrompt
      />
    );

    const button = screen.getByRole("button", { name: "Queued" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("opens the fork dialog from Fork…", () => {
    const onFork = vi.fn();
    render(<LimitReachedBanner limit={LIMIT} isProcessing={false} onFork={onFork} />);
    fireEvent.click(screen.getByRole("button", { name: "Fork…" }));
    expect(onFork).toHaveBeenCalledTimes(1);
  });
  describe("continue when it resets", () => {
    const SCHEDULED_AT_MS = Date.UTC(2026, 9, 22, 9, 1, 0);
    const ok = async () => ({ ok: true as const });

    it("offers to continue at the reset and schedules it", async () => {
      const onScheduleContinue = vi.fn(ok);
      render(
        <LimitReachedBanner
          limit={LIMIT}
          isProcessing={false}
          onScheduleContinue={onScheduleContinue}
        />
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Continue when it resets" }));
      });

      expect(onScheduleContinue).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("says when the session continues and cancels it", async () => {
      const onCancelScheduledContinue = vi.fn(ok);
      render(
        <LimitReachedBanner
          limit={LIMIT}
          isProcessing={false}
          scheduledContinueAtMs={SCHEDULED_AT_MS}
          onScheduleContinue={ok}
          onCancelScheduledContinue={onCancelScheduledContinue}
        />
      );

      expect(screen.getByRole("region")).toHaveTextContent(
        "Claude subscription limit reached (five-hour window, slot claude-5). Resets at 09:00 (in 4 min). The conversation and workspace are saved. Continues automatically at 09:01."
      );
      expect(screen.queryByRole("button", { name: "Continue when it resets" })).toBeNull();
      const cancel = screen.getByRole("button", { name: "Cancel the scheduled continue" });
      expect(cancel).toHaveTextContent("Cancel");

      await act(async () => {
        fireEvent.click(cancel);
      });

      expect(onCancelScheduledContinue).toHaveBeenCalledTimes(1);
    });

    it("hides the option once the reset has passed", () => {
      render(<LimitReachedBanner limit={LIMIT} isProcessing={false} onScheduleContinue={ok} />);
      expect(screen.getByRole("button", { name: "Continue when it resets" })).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(4 * 60_000 + LIMIT_COUNTDOWN_TICK_MS));

      expect(screen.queryByRole("button", { name: "Continue when it resets" })).toBeNull();
    });

    it("hides the option when the reset time is unknown", () => {
      render(
        <LimitReachedBanner
          limit={{ ...LIMIT, resetsAtMs: null }}
          isProcessing={false}
          onScheduleContinue={ok}
        />
      );
      expect(screen.queryByRole("button", { name: "Continue when it resets" })).toBeNull();
    });

    it("gives a viewer who cannot collaborate neither the option nor Cancel", () => {
      const { rerender } = render(<LimitReachedBanner limit={LIMIT} isProcessing={false} />);
      expect(screen.queryByRole("button", { name: "Continue when it resets" })).toBeNull();

      rerender(
        <LimitReachedBanner
          limit={LIMIT}
          isProcessing={false}
          scheduledContinueAtMs={SCHEDULED_AT_MS}
        />
      );
      expect(screen.getByRole("region")).toHaveTextContent("Continues automatically at 09:01.");
      expect(screen.queryByRole("button", { name: "Cancel the scheduled continue" })).toBeNull();
    });

    it("renders the scheduled clock only in the browser", () => {
      const html = renderToString(
        <LimitReachedBanner
          limit={LIMIT}
          isProcessing={false}
          scheduledContinueAtMs={SCHEDULED_AT_MS}
          onScheduleContinue={ok}
        />
      );
      expect(html).not.toContain("Continues automatically");
      expect(html).not.toContain("Continue when it resets");
    });

    it("keeps keyboard focus on one button that stays focusable while it works", async () => {
      let settle: () => void = () => {};
      function Host() {
        const [atMs, setAtMs] = useState<number | null>(null);
        const answer = (next: number | null) => () =>
          new Promise<{ ok: true }>((resolve) => {
            settle = () => {
              setAtMs(next);
              resolve({ ok: true });
            };
          });
        return (
          <LimitReachedBanner
            limit={LIMIT}
            isProcessing={false}
            scheduledContinueAtMs={atMs}
            onScheduleContinue={answer(SCHEDULED_AT_MS)}
            onCancelScheduledContinue={answer(null)}
          />
        );
      }
      render(<Host />);
      const button = screen.getByRole("button", { name: "Continue when it resets" });
      button.focus();

      act(() => {
        fireEvent.click(button);
      });
      // A disabled button drops focus to the page in browsers (HTML focus fixup).
      expect(button).toHaveTextContent("Scheduling…");
      expect(button).not.toBeDisabled();
      expect(button).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(button);
      await act(async () => settle());

      expect(screen.getByRole("button", { name: "Cancel the scheduled continue" })).toBe(button);
      expect(button).not.toHaveAttribute("aria-disabled", "true");
      expect(document.activeElement).toBe(button);

      act(() => {
        fireEvent.click(button);
      });
      expect(button).toHaveTextContent("Cancelling…");
      expect(button).not.toBeDisabled();
      await act(async () => settle());

      expect(screen.getByRole("button", { name: "Continue when it resets" })).toBe(button);
      expect(document.activeElement).toBe(button);
    });

    function CancellableHost({ onContinue }: { onContinue?: () => Promise<{ ok: true }> }) {
      const [atMs, setAtMs] = useState<number | null>(SCHEDULED_AT_MS);
      return (
        <LimitReachedBanner
          limit={LIMIT}
          isProcessing={false}
          onContinue={onContinue}
          scheduledContinueAtMs={atMs}
          onScheduleContinue={async () => {
            setAtMs(SCHEDULED_AT_MS);
            return { ok: true };
          }}
          onCancelScheduledContinue={async () => {
            setAtMs(null);
            return { ok: true };
          }}
        />
      );
    }

    it("announces a cancel the viewer made until they schedule again", async () => {
      render(<CancellableHost />);
      const [, notice] = screen.getAllByRole("status");
      expect(notice).toHaveTextContent("Continues automatically at 09:01.");

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel the scheduled continue" }));
      });
      expect(notice).toHaveTextContent("The scheduled continue was cancelled.");

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Continue when it resets" }));
      });
      expect(notice).toHaveTextContent("Continues automatically at 09:01.");
      expect(notice).not.toHaveTextContent("cancelled");
    });

    it("moves focus to Continue when a cancel after the reset removes its button", async () => {
      vi.setSystemTime(Date.UTC(2026, 9, 22, 9, 0, 30));
      render(<CancellableHost onContinue={ok} />);
      const cancel = screen.getByRole("button", { name: "Cancel the scheduled continue" });
      cancel.focus();

      await act(async () => {
        fireEvent.click(cancel);
      });

      expect(cancel).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Continue when it resets" })).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));
      expect(screen.getAllByRole("status")[1]).toHaveTextContent(
        "The scheduled continue was cancelled."
      );
    });

    it("moves focus to the banner when Continue cannot take it", async () => {
      vi.setSystemTime(Date.UTC(2026, 9, 22, 9, 0, 30));
      render(<CancellableHost />);
      const cancel = screen.getByRole("button", { name: "Cancel the scheduled continue" });
      cancel.focus();

      await act(async () => {
        fireEvent.click(cancel);
      });

      expect(document.activeElement).toBe(screen.getByRole("region"));
    });

    it("announces the schedule and its cancel from a region mounted with the banner", () => {
      const { rerender } = render(
        <LimitReachedBanner limit={LIMIT} isProcessing={false} onScheduleContinue={ok} />
      );
      const [, notice] = screen.getAllByRole("status");
      expect(notice).toBeEmptyDOMElement();

      rerender(
        <LimitReachedBanner
          limit={LIMIT}
          isProcessing={false}
          scheduledContinueAtMs={SCHEDULED_AT_MS}
          onScheduleContinue={ok}
        />
      );
      expect(screen.getAllByRole("status")[1]).toBe(notice);
      expect(notice).toHaveTextContent("Continues automatically at 09:01.");

      rerender(<LimitReachedBanner limit={LIMIT} isProcessing={false} onScheduleContinue={ok} />);
      expect(notice).toBeEmptyDOMElement();
    });

    it.each([
      [
        { reason: "refused", refusal: "usage_quota_exceeded", atMs: SCHEDULED_AT_MS },
        "The scheduled continue did not run: the person who scheduled it has reached a usage quota.",
      ],
      [
        { reason: "refused", refusal: "budget_exhausted", atMs: SCHEDULED_AT_MS },
        "The scheduled continue did not run: the session cost limit was reached.",
      ],
      [
        { reason: "requester_cannot_collaborate", refusal: null, atMs: SCHEDULED_AT_MS },
        "The scheduled continue did not run: the person who scheduled it can no longer work in this session.",
      ],
      [
        { reason: "retries_exhausted", refusal: null, atMs: SCHEDULED_AT_MS },
        "The scheduled continue did not run: the session could not queue it.",
      ],
    ] as const)("announces a scheduled continue that did not run (%o)", (failure, text) => {
      const { rerender } = render(
        <LimitReachedBanner
          limit={LIMIT}
          isProcessing={false}
          scheduledContinueAtMs={SCHEDULED_AT_MS}
        />
      );
      const [, notice] = screen.getAllByRole("status");

      rerender(
        <LimitReachedBanner limit={LIMIT} isProcessing={false} scheduledContinueFailure={failure} />
      );

      expect(screen.getAllByRole("status")[1]).toBe(notice);
      expect(notice).toHaveTextContent(text);
      expect(screen.getByRole("region")).toHaveTextContent(text);
    });

    it("reports a refused schedule and a failed cancel", async () => {
      const { rerender } = render(
        <LimitReachedBanner
          limit={LIMIT}
          isProcessing={false}
          onScheduleContinue={async () => ({
            ok: false as const,
            message: "This limit has no reset time ahead.",
          })}
        />
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Continue when it resets" }));
      });
      expect(screen.getByRole("alert")).toHaveTextContent("This limit has no reset time ahead.");

      rerender(
        <LimitReachedBanner
          limit={LIMIT}
          isProcessing={false}
          scheduledContinueAtMs={SCHEDULED_AT_MS}
          onCancelScheduledContinue={() => Promise.reject(new Error("network"))}
        />
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel the scheduled continue" }));
      });
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The scheduled continue could not be cancelled."
      );
    });
  });
});
