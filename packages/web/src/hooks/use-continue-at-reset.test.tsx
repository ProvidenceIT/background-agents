// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useContinueAtReset } from "./use-continue-at-reset";

type FetchCall = { url: string; method: string | undefined };

function stubFetch(response: () => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return response();
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useContinueAtReset", () => {
  it("schedules the continue and applies the scheduled time", async () => {
    const calls = stubFetch(() => Response.json({ scheduledContinueAtMs: 1_800_000_060_000 }));
    const apply = vi.fn();
    const { result } = renderHook(() => useContinueAtReset("session/1", apply));

    await act(async () => {
      await expect(result.current.schedule()).resolves.toEqual({ ok: true });
    });

    expect(calls).toEqual([{ url: "/api/sessions/session%2F1/continue-at-reset", method: "POST" }]);
    expect(apply).toHaveBeenCalledWith(1_800_000_060_000);
  });

  it("cancels the continue and clears the scheduled time", async () => {
    const calls = stubFetch(() => Response.json({ scheduledContinueAtMs: null }));
    const apply = vi.fn();
    const { result } = renderHook(() => useContinueAtReset("session-1", apply));

    await act(async () => {
      await expect(result.current.cancel()).resolves.toEqual({ ok: true });
    });

    expect(calls).toEqual([{ url: "/api/sessions/session-1/continue-at-reset", method: "DELETE" }]);
    expect(apply).toHaveBeenCalledWith(null);
  });

  it("explains a limit without a future reset and applies nothing", async () => {
    stubFetch(() =>
      Response.json({ error: "No future reset", code: "no_future_reset" }, { status: 409 })
    );
    const apply = vi.fn();
    const { result } = renderHook(() => useContinueAtReset("session-1", apply));

    await act(async () => {
      await expect(result.current.schedule()).resolves.toEqual({
        ok: false,
        message: "This limit has no reset time ahead. Continue now or fork the session instead.",
      });
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("relays other refusals and falls back when the request fails", async () => {
    stubFetch(() => Response.json({ error: "Forbidden" }, { status: 403 }));
    const { result } = renderHook(() => useContinueAtReset("session-1", vi.fn()));
    await act(async () => {
      await expect(result.current.cancel()).resolves.toEqual({ ok: false, message: "Forbidden" });
    });

    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await act(async () => {
      await expect(result.current.schedule()).resolves.toEqual({
        ok: false,
        message: "The continue could not be scheduled.",
      });
    });
  });

  it("rejects an answer that does not match the contract", async () => {
    const apply = vi.fn();
    stubFetch(() => Response.json({ scheduledContinueAtMs: "soon" }));
    const { result } = renderHook(() => useContinueAtReset("session-1", apply));

    await act(async () => {
      await expect(result.current.cancel()).resolves.toEqual({
        ok: false,
        message: "The scheduled continue could not be cancelled.",
      });
    });
    expect(apply).not.toHaveBeenCalled();
  });
});
