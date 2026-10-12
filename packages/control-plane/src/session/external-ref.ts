import { sha256Hex, type ServiceName } from "@open-inspect/shared/service-auth";
import type { CreateSessionInput } from "@open-inspect/shared/types/session-api";
import type { CorrelationContext } from "../logger";
import type { Env } from "../types";
import { SessionInternalPaths } from "./contracts";
import { createSessionRuntimeClient } from "./runtime-client";

/**
 * How long a `created` session row with an external ref and no runtime is
 * treated as a first attempt still in flight. After it, a retry releases the
 * ref and creates afresh.
 */
export const EXTERNAL_REF_PENDING_LEASE_MS = 120_000;

/** Seconds a client should wait before retrying an in-flight or indeterminate ref. */
export const EXTERNAL_REF_RETRY_AFTER_SECONDS = 5;

/** A service's idempotency key for one session create, as stored on the session row. */
export interface SessionExternalRef {
  service: ServiceName;
  ref: string;
  fingerprint: string;
}

/** The fingerprint version; a later field list gets a new prefix. */
const FINGERPRINT_VERSION = "v1";

/**
 * The request fields that decide what session a create starts. Profile fields
 * (`scm*`, `actor*`) describe the caller, not the session, and the ref itself
 * is the key, so neither is part of the fingerprint.
 */
const FINGERPRINT_FIELDS = [
  "repoOwner",
  "repoName",
  "branch",
  "repositories",
  "environmentId",
  "title",
  "harness",
  "model",
  "reasoningEffort",
  "teamId",
  "visibility",
  "skillSelection",
  "includePersonalMemories",
  "providerSelections",
  "triggerKind",
  "workItemAuthorScmUserId",
] as const satisfies readonly (keyof CreateSessionInput)[];

/**
 * JSON with object keys sorted at every depth and `undefined` members dropped;
 * `null` and array order are kept.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
}

/** The versioned fingerprint of a create request's session-defining fields. */
export async function externalRefFingerprint(body: CreateSessionInput): Promise<string> {
  const picked: Record<string, unknown> = {};
  for (const field of FINGERPRINT_FIELDS) picked[field] = body[field];
  return `${FINGERPRINT_VERSION}:${await sha256Hex(canonicalJson(picked))}`;
}

/** Thrown by the session store when another row already holds the external ref. */
export class SessionExternalRefTakenError extends Error {
  constructor(readonly existingSessionId: string) {
    super("External ref is already held by another session");
    this.name = "SessionExternalRefTakenError";
  }
}

/**
 * Whether the session's runtime was initialized: `missing` only on the
 * runtime's own 404, `unknown` on any other answer or a transport failure.
 */
export async function probeSessionRuntime(
  env: Env,
  ctx: CorrelationContext,
  sessionId: string
): Promise<"exists" | "missing" | "unknown"> {
  try {
    const response = await createSessionRuntimeClient(env, ctx).fetch(
      sessionId,
      SessionInternalPaths.state,
      { method: "GET" }
    );
    await response.body?.cancel();
    if (response.ok) return "exists";
    return response.status === 404 ? "missing" : "unknown";
  } catch {
    return "unknown";
  }
}
