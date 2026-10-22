import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { DELETE, POST } from "./route";

function call(handler: typeof POST, method: "POST" | "DELETE", id = "session-1") {
  return handler(
    new NextRequest(`http://localhost/api/sessions/${id}/continue-at-reset`, { method }),
    { params: Promise.resolve({ id }) }
  );
}

describe("continue-at-reset API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("schedules the continue without a body", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ scheduledContinueAtMs: 1_790_000_060_000 })
    );

    const response = await call(POST, "POST");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ scheduledContinueAtMs: 1_790_000_060_000 });
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/session-1/continue-at-reset", {
      method: "POST",
    });
  });

  it("cancels the scheduled continue", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ scheduledContinueAtMs: null })
    );

    const response = await call(DELETE, "DELETE", "a/b");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ scheduledContinueAtMs: null });
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/a%2Fb/continue-at-reset", {
      method: "DELETE",
    });
  });

  it("relays a refusal when the limit has no future reset", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "No future reset", code: "no_future_reset" }, { status: 409 })
    );

    const response = await call(POST, "POST");

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "No future reset",
      code: "no_future_reset",
    });
  });

  it("requires a signed-in user", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null as never);

    const response = await call(DELETE, "DELETE");

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("answers 500 when the control plane cannot be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(controlPlaneUserFetch).mockRejectedValue(new Error("network down"));

    const response = await call(POST, "POST");

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to schedule the continue" });
  });
});
