// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useContinueAfterLimit } from "./use-continue-after-limit";

type SendPrompt = Parameters<typeof useContinueAfterLimit>[0];

function sendPromptReturning(...results: Awaited<ReturnType<SendPrompt>>[]) {
  const sendPrompt = vi.fn<SendPrompt>();
  for (const result of results) sendPrompt.mockResolvedValueOnce(result);
  return sendPrompt;
}

describe("useContinueAfterLimit", () => {
  it("retries a timed-out continue with the same client request id", async () => {
    const sendPrompt = sendPromptReturning(
      { ok: false, reason: "timeout" },
      { ok: true, clientRequestId: "x", messageId: "m-1", position: 0 }
    );
    const { result } = renderHook(() =>
      useContinueAfterLimit(sendPrompt, "anthropic/claude-opus-4-6", "high")
    );

    await act(async () => {
      await expect(result.current()).resolves.toEqual({
        ok: false,
        message: "Sending the continue prompt timed out.",
      });
    });
    await act(async () => {
      await expect(result.current()).resolves.toEqual({ ok: true });
    });

    expect(sendPrompt).toHaveBeenCalledTimes(2);
    const [first, second] = sendPrompt.mock.calls;
    expect(first.slice(0, 4)).toEqual([
      "Continue where you stopped.",
      "anthropic/claude-opus-4-6",
      "high",
      undefined,
    ]);
    expect(first[4]).toEqual(expect.any(String));
    expect(second[4]).toBe(first[4]);
  });

  it("uses a new request id once a continue was queued", async () => {
    const sendPrompt = sendPromptReturning(
      { ok: true, clientRequestId: "x", messageId: "m-1", position: 0 },
      { ok: false, reason: "disconnected" }
    );
    const { result } = renderHook(() =>
      useContinueAfterLimit(sendPrompt, "anthropic/claude-opus-4-6", undefined)
    );

    await act(async () => {
      await result.current();
    });
    await act(async () => {
      await expect(result.current()).resolves.toEqual({
        ok: false,
        message: "Reconnect before continuing.",
      });
    });

    const [first, second] = sendPrompt.mock.calls;
    expect(second[4]).not.toBe(first[4]);
  });
});
