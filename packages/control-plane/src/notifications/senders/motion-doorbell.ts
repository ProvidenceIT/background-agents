import { bytesToHex, computeHmacHex } from "@open-inspect/shared/auth";
import {
  SERVICE_HEADER,
  SERVICE_SIGNATURE_HEADER,
  SIG1_PREFIX,
  buildCanonicalRequestString,
  sha256Hex,
  type ServiceName,
} from "@open-inspect/shared/service-auth";
import { sessionExternalRefSchema } from "@open-inspect/shared/types/session-api";
import { z } from "zod";
import type { Logger } from "../../logger";
import {
  SETTLED_STATUSES,
  type NoticeChannel,
  type NoticeDeliveryOutcome,
  type SettledStatus,
} from "../registry";

/**
 * Motion's doorbell: a signed, actorless, metadata-only poke telling motion
 * that the session it delegated (by `external_ref`) settled at a revision.
 * Motion trusts the body only for which row to look at, then re-reads the
 * session from Open-Inspect as that row's requester, so the body carries
 * ids, a status and a revision, nothing else. The wire contract (path,
 * body bytes, signature) is pinned in the software-factory notes,
 * `session-tools-doorbell-contract.md`; a change to it is a change on both
 * sides.
 */

export const MOTION_NOTICE_CHANNEL = "motion";
/** The receiver's route; the signature covers it, so it never carries a query. */
export const MOTION_DOORBELL_PATH = "/api/v1/open-inspect/events";
export const MOTION_DOORBELL_TIMEOUT_MS = 10_000;
/** Motion's own sweep has settled the row by then; a later poke is noise. */
export const MOTION_DOORBELL_MAX_AGE_MS = 15 * 60 * 1000;
/** The longest `Retry-After` honoured; a longer one would outlive the row. */
export const MOTION_DOORBELL_MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

/**
 * The signer named in the canonical string. Not one of `SERVICE_NAMES`, which
 * lists the services that call in; the cast only borrows the shared sig1
 * template, whose bytes the contract's vectors pin.
 */
const DOORBELL_SIGNER = "open-inspect" as ServiceName;
const DOORBELL_TYPE = "session.settled";

/**
 * The answers worth another attempt. Any other non-2xx will not change on a
 * retry: a 401 is a secret mismatch or clock skew an operator has to see.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `MOTION_CALLBACK_URL` as a base URL without a trailing slash: `https:`, or
 * `http:` to this machine only, with no query or fragment.
 */
export function parseMotionCallbackUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`MOTION_CALLBACK_URL must be an absolute https URL, got ${raw}`);
  }
  const local = url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new Error(
      `MOTION_CALLBACK_URL must be an https URL (http only to localhost), got ${raw}`
    );
  }
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) {
    throw new Error(`MOTION_CALLBACK_URL must not carry a query or fragment, got ${raw}`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

const motionDoorbellBodySchema = z.strictObject({
  type: z.literal(DOORBELL_TYPE),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  externalRef: sessionExternalRefSchema,
  status: z.enum(SETTLED_STATUSES),
  revision: z.number().int().min(1),
  occurredAt: z.iso.datetime({ precision: 3 }),
});

export interface MotionDoorbellFields {
  sessionId: string;
  externalRef: string;
  status: SettledStatus;
  revision: number;
  occurredAtMs: number;
}

/**
 * The exact body bytes, keys in the contract's order. Stored as the row's
 * payload and sent unchanged on every attempt, since motion hashes what it
 * receives. Throws when a field is outside the contract.
 */
export function motionDoorbellBody(fields: MotionDoorbellFields): string {
  const body = motionDoorbellBodySchema.parse({
    type: DOORBELL_TYPE,
    sessionId: fields.sessionId,
    externalRef: fields.externalRef,
    status: fields.status,
    revision: fields.revision,
    occurredAt: new Date(fields.occurredAtMs).toISOString(),
  });
  return JSON.stringify(body);
}

/** The `X-OpenInspect-Service-Signature` value for `body` at `timestampMs`. */
export async function signMotionDoorbell(p: {
  secret: string;
  body: string;
  timestampMs: number;
  nonce: string;
}): Promise<string> {
  const canonical = buildCanonicalRequestString({
    service: DOORBELL_SIGNER,
    timestampMs: p.timestampMs,
    nonce: p.nonce,
    method: "POST",
    pathname: MOTION_DOORBELL_PATH,
    canonicalQuery: "",
    bodySha256Hex: await sha256Hex(p.body),
    actor: "",
  });
  const signature = await computeHmacHex(canonical, p.secret);
  return `${SIG1_PREFIX}.${p.timestampMs}.${p.nonce}.${signature}`;
}

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** `Retry-After` in seconds or as an HTTP date, capped; undefined when absent or unreadable. */
function retryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  const ms = /^[0-9]+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - nowMs;
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(0, ms), MOTION_DOORBELL_MAX_RETRY_AFTER_MS);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export interface MotionDoorbellChannelDeps {
  /** From `parseMotionCallbackUrl`. */
  callbackUrl: string;
  /** `SERVICE_AUTH_SECRET_MOTION_CALLBACK`; never logged, never sent. */
  secret: string;
  log: Logger;
  fetch?: typeof fetch;
  /** Signing time; each attempt is signed at its own moment. */
  clock?: () => number;
  nonce?: () => string;
}

export function motionDoorbellChannel(deps: MotionDoorbellChannelDeps): NoticeChannel {
  const endpoint = `${deps.callbackUrl}${MOTION_DOORBELL_PATH}`;
  const fetchImpl = deps.fetch ?? fetch;
  const clock = deps.clock ?? Date.now;
  const nonce = deps.nonce ?? randomNonce;

  return {
    id: MOTION_NOTICE_CHANNEL,
    maxAgeMs: MOTION_DOORBELL_MAX_AGE_MS,

    // The mode decides; the Teams channel toggle is not this channel's.
    isEnabled: () => true,

    async address(session) {
      if (session.externalRef?.service !== MOTION_NOTICE_CHANNEL) return [];
      let payload: string;
      try {
        payload = motionDoorbellBody({
          sessionId: session.sessionId,
          externalRef: session.externalRef.ref,
          status: session.status,
          revision: session.revision,
          occurredAtMs: session.occurredAtMs,
        });
      } catch {
        deps.log.warn("notifications.motion_doorbell", {
          outcome: "unaddressable",
          session_id: session.sessionId,
          revision: session.revision,
        });
        return [];
      }
      return [{ recipientRef: session.externalRef.ref, payload }];
    },

    async deliver(notice): Promise<NoticeDeliveryOutcome> {
      const fields = { session_id: notice.sessionId, revision: notice.revision };
      const parsed = (() => {
        try {
          return motionDoorbellBodySchema.safeParse(JSON.parse(notice.payload)).success;
        } catch {
          return false;
        }
      })();
      if (!parsed) return { kind: "permanent", code: "invalid_payload" };

      const timestampMs = clock();
      const headers = {
        "Content-Type": "application/json",
        [SERVICE_HEADER]: DOORBELL_SIGNER,
        [SERVICE_SIGNATURE_HEADER]: await signMotionDoorbell({
          secret: deps.secret,
          body: notice.payload,
          timestampMs,
          nonce: nonce(),
        }),
      };

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers,
          body: notice.payload,
          // A redirect would re-post the signed body somewhere the signature does not name.
          redirect: "manual",
          signal: AbortSignal.timeout(MOTION_DOORBELL_TIMEOUT_MS),
        });
      } catch (error) {
        const code = isTimeout(error) ? "timeout" : "network";
        deps.log.warn("notifications.motion_doorbell", { ...fields, outcome: "retryable", code });
        return { kind: "retryable", code };
      }
      // Motion's answer is never read: its body stays out of the logs and the row.
      await response.body?.cancel().catch(() => {});

      const status = response.status;
      let outcome: NoticeDeliveryOutcome;
      if (status >= 200 && status < 300) {
        outcome = { kind: "sent" };
      } else if (status === 404) {
        outcome = { kind: "permanent", code: "receiver_off" };
      } else if (!isRetryableStatus(status)) {
        outcome = { kind: "permanent", code: `http_${status}` };
      } else {
        const waitMs = retryAfterMs(response.headers.get("Retry-After"), timestampMs);
        outcome = {
          kind: "retryable",
          code: `http_${status}`,
          ...(waitMs === undefined ? {} : { retryAfterMs: waitMs }),
        };
      }
      const log = outcome.kind === "sent" ? deps.log.info : deps.log.warn;
      log.call(deps.log, "notifications.motion_doorbell", {
        ...fields,
        outcome: outcome.kind,
        http_status: status,
      });
      return outcome;
    },
  };
}
