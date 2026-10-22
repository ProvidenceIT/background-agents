import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { forkSessionRequestSchema } from "@open-inspect/shared/types/session-api";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PRIVATE_NO_STORE_HEADERS, relayJsonResponse } from "@/lib/control-plane-json-proxy";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: PRIVATE_NO_STORE_HEADERS }
    );
  }

  const { id } = await params;
  try {
    const parsed = forkSessionRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.join(".");
      return NextResponse.json(
        {
          error: field ? `${field}: ${issue.message}` : (issue?.message ?? "Invalid fork request"),
        },
        { status: 400, headers: PRIVATE_NO_STORE_HEADERS }
      );
    }

    const response = await controlPlaneUserFetch(`/sessions/${encodeURIComponent(id)}/fork`, {
      method: "POST",
      body: JSON.stringify(parsed.data),
    });
    return relayJsonResponse(response);
  } catch (error) {
    console.error("Failed to fork session:", error);
    return NextResponse.json(
      { error: "Failed to fork session" },
      { status: 500, headers: PRIVATE_NO_STORE_HEADERS }
    );
  }
}
