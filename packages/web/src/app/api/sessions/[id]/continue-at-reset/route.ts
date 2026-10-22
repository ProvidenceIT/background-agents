import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PRIVATE_NO_STORE_HEADERS, relayJsonResponse } from "@/lib/control-plane-json-proxy";

type RouteContext = { params: Promise<{ id: string }> };

/** Both methods take no body; the control plane rejects one on POST. */
async function relayContinueAtReset(
  method: "POST" | "DELETE",
  { params }: RouteContext,
  action: string
): Promise<NextResponse> {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: PRIVATE_NO_STORE_HEADERS }
    );
  }

  const { id } = await params;
  try {
    const response = await controlPlaneUserFetch(
      `/sessions/${encodeURIComponent(id)}/continue-at-reset`,
      { method }
    );
    return relayJsonResponse(response);
  } catch (error) {
    console.error(`Failed to ${action}:`, error);
    return NextResponse.json(
      { error: `Failed to ${action}` },
      { status: 500, headers: PRIVATE_NO_STORE_HEADERS }
    );
  }
}

export function POST(_request: NextRequest, context: RouteContext) {
  return relayContinueAtReset("POST", context, "schedule the continue");
}

export function DELETE(_request: NextRequest, context: RouteContext) {
  return relayContinueAtReset("DELETE", context, "cancel the scheduled continue");
}
