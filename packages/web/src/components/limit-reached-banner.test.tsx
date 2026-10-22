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
  it("renders nothing without a limit", () => {
    const { container } = render(<LimitReachedBanner limit={null} isProcessing={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says which limit was hit, when it resets and that the work is saved", () => {
    render(<LimitReachedBanner limit={LIMIT} isProcessing={false} />);
    expect(screen.getByRole("status", { name: "Subscription limit reached" })).toHaveTextContent(
      "Claude subscription limit reached (five-hour window, slot claude-5). Resets at 09:00 (in 4 min). The conversation and workspace are saved."
    );
  });

  it("counts down and reports the reset once it passes", () => {
    render(<LimitReachedBanner limit={LIMIT} isProcessing={false} />);
    act(() => vi.advanceTimersByTime(2 * 60_000));
    expect(screen.getByRole("status")).toHaveTextContent("Resets at 09:00 (in 2 min).");
    act(() => vi.advanceTimersByTime(2 * 60_000 + LIMIT_COUNTDOWN_TICK_MS));
    expect(screen.getByRole("status")).toHaveTextContent("The limit has reset.");
    expect(screen.getByRole("status")).not.toHaveTextContent("Resets at");
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
