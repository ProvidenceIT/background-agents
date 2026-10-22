import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { POST } from "./route";
import { GET as getHandoff } from "./handoff/route";
import { GET as getSubscriptionSlots } from "./subscription-slots/route";

const FORK_REQUEST_ID = "6f1c2a4e-9b7d-4c1e-8a2f-0d3b5e7f9a1c";

function postFork(body: unknown, id = "session-1") {
  return POST(
    new NextRequest(`http://localhost/api/sessions/${id}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

describe("session fork API routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("proxies a valid fork request and keeps the created status", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json(
        { sessionId: "session-2", forkedFromSessionId: "session-1", created: true },
        { status: 201 }
      )
    );

    const response = await postFork({
      forkRequestId: FORK_REQUEST_ID,
      handoff: "Continue the refactor.",
      harness: "codex",
      model: "openai/gpt-5.4",
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      sessionId: "session-2",
      forkedFromSessionId: "session-1",
      created: true,
    });
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/session-1/fork", {
      method: "POST",
      body: JSON.stringify({
        forkRequestId: FORK_REQUEST_ID,
        handoff: "Continue the refactor.",
        harness: "codex",
        model: "openai/gpt-5.4",
      }),
    });
  });

  it("relays a replayed fork as 200 with created false", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ sessionId: "session-2", forkedFromSessionId: "session-1", created: false })
    );

    const response = await postFork({ forkRequestId: FORK_REQUEST_ID });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sessionId: "session-2",
      forkedFromSessionId: "session-1",
      created: false,
    });
  });

  it("rejects a request without a fork request id before proxying", async () => {
    const response = await postFork({ handoff: "Go on" });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/^forkRequestId: /);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("rejects unknown keys and blank handoffs before proxying", async () => {
    const unknownKey = await postFork({ forkRequestId: FORK_REQUEST_ID, carry: "handoff" });
    const blank = await postFork({ forkRequestId: FORK_REQUEST_ID, handoff: "  \n" });

    expect(unknownKey.status).toBe(400);
    expect(blank.status).toBe(400);
    await expect(blank.json()).resolves.toEqual({ error: "handoff: handoff must not be blank" });
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("requires a signed-in user", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null as never);

    const response = await postFork({ forkRequestId: FORK_REQUEST_ID });

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("relays control-plane refusals unchanged", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Forbidden" }, { status: 403 })
    );

    const response = await postFork({ forkRequestId: FORK_REQUEST_ID });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("fetches the handoff draft for the source session", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ handoff: "# Handoff\n\nGoal: ship it." })
    );

    const response = await getHandoff(
      new NextRequest("http://localhost/api/sessions/session-1/fork/handoff"),
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ handoff: "# Handoff\n\nGoal: ship it." });
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions/session-1/fork/handoff",
      undefined
    );
  });
  it("proxies a chosen subscription slot", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json(
        { sessionId: "session-2", forkedFromSessionId: "session-1", created: true },
        { status: 201 }
      )
    );

    await postFork({
      forkRequestId: FORK_REQUEST_ID,
      harness: "claude",
      subscriptionSlot: "claude-3",
    });

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/session-1/fork", {
      method: "POST",
      body: JSON.stringify({
        forkRequestId: FORK_REQUEST_ID,
        harness: "claude",
        subscriptionSlot: "claude-3",
      }),
    });
  });

  it("rejects a malformed subscription slot before proxying", async () => {
    const response = await postFork({ forkRequestId: FORK_REQUEST_ID, subscriptionSlot: "../x" });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/^subscriptionSlot: /);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("relays an unavailable subscription slot as 400 with its code", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json(
        { error: "Subscription slot unavailable", code: "subscription_slot_unavailable" },
        { status: 400 }
      )
    );

    const response = await postFork({
      forkRequestId: FORK_REQUEST_ID,
      subscriptionSlot: "claude-9",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Subscription slot unavailable",
      code: "subscription_slot_unavailable",
    });
  });

  it("lists the subscription slots for the requested harness", async () => {
    const slots = {
      harness: "claude",
      slots: [
        { slot: "claude-1", percentRemaining: null, lastUsedAt: 1_790_000_000_000 },
        { slot: "claude-2", percentRemaining: 72, lastUsedAt: null },
      ],
    };
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(slots));

    const response = await getSubscriptionSlots(
      new NextRequest(
        "http://localhost/api/sessions/session-1/fork/subscription-slots?harness=claude&x=1"
      ),
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(slots);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions/session-1/fork/subscription-slots?harness=claude",
      undefined
    );
  });

  it("relays the control plane's 400 for a missing harness", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "harness is required" }, { status: 400 })
    );

    const response = await getSubscriptionSlots(
      new NextRequest("http://localhost/api/sessions/session-1/fork/subscription-slots"),
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(400);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions/session-1/fork/subscription-slots",
      undefined
    );
  });
});
