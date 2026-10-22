// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

    expect(screen.getByRole("status")).toBe(liveRegion);
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

  it("counts down and reports the reset once it passes", () => {
    render(<LimitReachedBanner limit={LIMIT} isProcessing={false} />);
    const banner = screen.getByRole("region");
    act(() => vi.advanceTimersByTime(2 * 60_000));
    expect(banner).toHaveTextContent("Resets at 09:00 (in 2 min).");
    expect(screen.getByRole("status")).not.toHaveTextContent("Resets at");
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

  it("opens the fork dialog from Fork…", () => {
    const onFork = vi.fn();
    render(<LimitReachedBanner limit={LIMIT} isProcessing={false} onFork={onFork} />);
    fireEvent.click(screen.getByRole("button", { name: "Fork…" }));
    expect(onFork).toHaveBeenCalledTimes(1);
  });
});
