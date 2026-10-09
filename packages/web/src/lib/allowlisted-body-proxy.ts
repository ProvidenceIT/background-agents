import { readBodyCapped } from "@open-inspect/shared/http-body";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PRIVATE_NO_STORE_HEADERS, relayJsonResponse } from "@/lib/control-plane-json-proxy";

/** A settings write is a few hundred bytes; anything near this is not one. */
const MAX_BODY_BYTES = 64 * 1024;

function failure(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

/**
 * A JSON write proxy that forwards only the named top-level fields of the
 * browser's body. The control plane takes the actor from the signed-in
 * session the request carries; a user id, actor or identity field the
 * browser adds is dropped here so it can never reach it, and the control
 * plane's own schema still validates what remains.
 */
export function allowlistedJsonWrite(
  path: string,
  fields: readonly string[],
  label: string,
  method: "PUT" | "POST" | "PATCH" = "PUT"
): (request: NextRequest) => Promise<NextResponse> {
  return async (request) => {
    const bytes = await readBodyCapped(request.body, MAX_BODY_BYTES);
    if (!bytes) return failure("Request body is too large", 413);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return failure("Request body must be JSON", 400);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return failure("Request body must be a JSON object", 400);
    }
    const source = parsed as Record<string, unknown>;
    const body = Object.fromEntries(
      fields.filter((field) => field in source).map((field) => [field, source[field]])
    );
    try {
      return relayJsonResponse(
        await controlPlaneUserFetch(path, { method, body: JSON.stringify(body) })
      );
    } catch (error) {
      console.error(`Failed to update ${label}:`, error);
      return failure(`Failed to update ${label}`, 500);
    }
  };
}
