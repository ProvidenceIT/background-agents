import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { controlPlaneUserFetch } from "@/lib/control-plane";
import { hostileIdentityFields } from "../../hostile-identity.test-fixture";
import { DELETE, GET, PUT } from "./route";

const params = { params: Promise.resolve(undefined) };
const registration = {
  pvcName: "sf-home-bram",
  nodeName: "sandbox-node-1",
  providers: ["anthropic", "openai"],
  kindsEnabled: ["prompt", "mention"],
  backgroundConsent: true,
  maxConcurrent: 2,
  shared: true,
  status: "active",
};

function put(body: unknown) {
  return PUT(
    new NextRequest("http://localhost/api/me/auth-home", {
      method: "PUT",
      headers: { Cookie: "openinspect.session_token=value", "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

function sentBody(): unknown {
  const init = vi.mocked(controlPlaneUserFetch).mock.calls[0]?.[1];
  return JSON.parse(String(init?.body));
}

describe("/api/me/auth-home", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(controlPlaneUserFetch).mockImplementation(async () =>
      Response.json({ home: { id: "ah_1" } })
    );
  });

  it("forwards the caller's own home fields and never a body-supplied identity", async () => {
    const response = await put({
      ...registration,
      ...hostileIdentityFields,
      ownerUserIds: ["attacker"],
      ownerUserId: "attacker",
      claudeExpiresAt: 1,
      sharingConsentAt: 1,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(controlPlaneUserFetch).toHaveBeenCalledExactlyOnceWith("/me/auth-home", {
      method: "PUT",
      body: JSON.stringify(registration),
    });
    expect(sentBody()).toEqual(registration);
  });

  it("relays the control plane's 403 and 409 as they are", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValueOnce(
      Response.json({ error: "Permission required", code: "permission_required" }, { status: 403 })
    );
    const denied = await put(registration);
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({
      error: "Permission required",
      code: "permission_required",
    });

    vi.mocked(controlPlaneUserFetch).mockResolvedValueOnce(
      Response.json({ error: "That volume claim is registered to another home" }, { status: 409 })
    );
    expect((await put(registration)).status).toBe(409);
  });

  it("refuses a body that is not a JSON object before calling the control plane", async () => {
    expect((await put("not json")).status).toBe(400);
    expect((await put([registration])).status).toBe(400);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("reads and removes only /me/auth-home, with no body or identity attached", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValueOnce(
      Response.json({ error: "No subscription home is registered for you" }, { status: 404 })
    );
    const read = await GET(
      new NextRequest("http://localhost/api/me/auth-home?userId=attacker"),
      params
    );
    expect(read.status).toBe(404);
    expect(controlPlaneUserFetch).toHaveBeenLastCalledWith("/me/auth-home", undefined);

    vi.mocked(controlPlaneUserFetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const removed = await DELETE(
      new NextRequest("http://localhost/api/me/auth-home", {
        method: "DELETE",
        headers: { Cookie: "openinspect.session_token=value" },
      }),
      params
    );
    expect(removed.status).toBe(204);
    expect(controlPlaneUserFetch).toHaveBeenLastCalledWith("/me/auth-home", { method: "DELETE" });
  });
});
