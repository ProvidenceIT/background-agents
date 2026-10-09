import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { controlPlaneUserFetch } from "@/lib/control-plane";
import { hostileIdentityFields } from "../hostile-identity.test-fixture";
import { GET as listHomes } from "../auth-homes/route";
import { GET, PUT } from "./route";

const params = { params: Promise.resolve(undefined) };

function put(body: unknown) {
  return PUT(
    new NextRequest("http://localhost/api/subscription-sharing", {
      method: "PUT",
      headers: { Cookie: "openinspect.session_token=value", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("/api/subscription-sharing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(controlPlaneUserFetch).mockImplementation(async () =>
      Response.json({ policy: "owner_only", updatedBy: "user-1", updatedAt: 1 })
    );
  });

  it("forwards only the policy, never a body-supplied identity", async () => {
    const response = await put({
      policy: "owner_only",
      ...hostileIdentityFields,
      updatedBy: "attacker",
    });

    expect(response.status).toBe(200);
    expect(controlPlaneUserFetch).toHaveBeenCalledExactlyOnceWith("/subscription-sharing", {
      method: "PUT",
      body: JSON.stringify({ policy: "owner_only" }),
    });
  });

  it("returns the control plane's 403 for a caller without subscription_sharing.manage", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValueOnce(
      Response.json({ error: "Permission required", code: "permission_required" }, { status: 403 })
    );
    const response = await put({ policy: "household" });
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Permission required",
      code: "permission_required",
    });
  });

  it("reads the policy and the enrolled homes from their control-plane paths", async () => {
    await GET(new NextRequest("http://localhost/api/subscription-sharing"), params);
    expect(controlPlaneUserFetch).toHaveBeenLastCalledWith("/subscription-sharing", undefined);

    vi.mocked(controlPlaneUserFetch).mockResolvedValueOnce(
      Response.json({ error: "Permission required" }, { status: 403 })
    );
    const homes = await listHomes(
      new NextRequest("http://localhost/api/auth-homes?owner=attacker"),
      params
    );
    expect(homes.status).toBe(403);
    expect(controlPlaneUserFetch).toHaveBeenLastCalledWith("/auth-homes", undefined);
  });
});
