import { describe, expect, it, vi } from "vitest";
import { NOTIFICATION_DEFAULTS } from "@open-inspect/shared/types/integrations";
import type { ClaimedSessionNotice } from "../notice-store";
import { silentLogger } from "../notifications.test-support";
import type { SettledSession } from "../registry";
import {
  MOTION_DOORBELL_MAX_RETRY_AFTER_MS,
  MOTION_DOORBELL_PATH,
  MOTION_NOTICE_CHANNEL,
  motionDoorbellBody,
  motionDoorbellChannel,
  parseMotionCallbackUrl,
  signMotionDoorbell,
} from "./motion-doorbell";

/** The wire contract's vectors (notes/session-tools-doorbell-contract.md, section 8). */
const VECTOR_1 = {
  secret: "doorbell-test-secret-0001",
  timestampMs: 1792800000000,
  nonce: "0123456789abcdef",
  body: '{"type":"session.settled","sessionId":"9f2c4e1a7b3d5f60a1b2c3d4e5f60718","externalRef":"providence/delegated-work/cmh1x2y3z0000abcd1234efgh","status":"completed","revision":7,"occurredAt":"2026-10-23T09:59:58.123Z"}',
  header:
    "sig1.1792800000000.0123456789abcdef.37f5c25f69bab9652b1cf47339ca866fbde1bdc5fa30d8a3d43bcec5f5a34c06",
};
const VECTOR_2 = {
  secret: "doorbell-test-secret-0002",
  timestampMs: 1792800300000,
  nonce: "fedcba9876543210",
  body: '{"type":"session.settled","sessionId":"00112233445566778899aabbccddeeff","externalRef":"providence/delegated-work/cmh9z8y7x0000wxyz9876abcd","status":"failed","revision":3,"occurredAt":"2026-10-23T10:04:59.000Z"}',
  header:
    "sig1.1792800300000.fedcba9876543210.d5069a5c757e357e674ceef0b4cad6d09bb1d6e9e33ddeda18f1d7c863971320",
};

const SESSION = "9f2c4e1a7b3d5f60a1b2c3d4e5f60718";
const REF = "providence/delegated-work/cmh1x2y3z0000abcd1234efgh";
const OCCURRED_AT_MS = Date.parse("2026-10-23T09:59:58.123Z");

function settled(overrides: Partial<SettledSession> = {}): SettledSession {
  return {
    sessionId: SESSION,
    status: "completed",
    occurredAtMs: OCCURRED_AT_MS,
    envelope: null,
    revision: 7,
    spawnSource: "motion",
    repliedInChatThread: false,
    watchingUserIds: [],
    lastTurnDurationMs: null,
    ownerUserId: "user-owner",
    ownerWatching: false,
    externalRef: { service: "motion", ref: REF },
    settings: { ...NOTIFICATION_DEFAULTS, enabled: true, mode: "live" },
    ...overrides,
  };
}

function claimed(payload: string, attempts = 1): ClaimedSessionNotice {
  return {
    id: 1,
    sessionId: SESSION,
    revision: 7,
    channel: MOTION_NOTICE_CHANNEL,
    recipientRef: REF,
    payload,
    attempts,
    createdAt: VECTOR_1.timestampMs,
  };
}

interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function harness(reply: () => Promise<Response> = async () => new Response(null, { status: 202 })) {
  const sent: SentRequest[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: String(init?.body),
    });
    return reply();
  });
  const nonces = [VECTOR_1.nonce, "aaaaaaaaaaaaaaaa"];
  const clock = { now: VECTOR_1.timestampMs };
  const log = silentLogger();
  const channel = motionDoorbellChannel({
    callbackUrl: parseMotionCallbackUrl("https://motion.example.test/"),
    secret: VECTOR_1.secret,
    log,
    fetch: fetchImpl as unknown as typeof fetch,
    clock: () => clock.now,
    nonce: () => nonces.shift() ?? "bbbbbbbbbbbbbbbb",
  });
  return { channel, sent, fetchImpl, clock, log };
}

describe("signMotionDoorbell", () => {
  it("reproduces the contract's vectors byte for byte", async () => {
    for (const vector of [VECTOR_1, VECTOR_2]) {
      expect(await signMotionDoorbell(vector)).toBe(vector.header);
    }
  });

  it("binds the body: one changed byte changes the signature", async () => {
    const body = VECTOR_1.body.replace('"revision":7', '"revision":8');
    expect(await signMotionDoorbell({ ...VECTOR_1, body })).toBe(
      "sig1.1792800000000.0123456789abcdef.a540c8b62fee7d6e05d57d8d4276d3699641272586b89c90da898a7d105e2141"
    );
  });
});

describe("motionDoorbellBody", () => {
  it("serializes the closed body in the contract's key order and nothing else", () => {
    expect(
      motionDoorbellBody({
        sessionId: SESSION,
        externalRef: REF,
        status: "completed",
        revision: 7,
        occurredAtMs: OCCURRED_AT_MS,
      })
    ).toBe(VECTOR_1.body);
  });
});

describe("parseMotionCallbackUrl", () => {
  it("takes an https origin, or http to localhost, and strips the trailing slash", () => {
    expect(parseMotionCallbackUrl("https://motion.providenceit.nl/")).toBe(
      "https://motion.providenceit.nl"
    );
    expect(parseMotionCallbackUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(parseMotionCallbackUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
  });

  it("refuses plain http elsewhere, a path, a query, a fragment and a relative URL", () => {
    for (const raw of [
      "https://example.test/motion",
      "http://motion.providenceit.nl",
      "https://motion.example.test/?a=1",
      "https://motion.example.test/#x",
      "motion.example.test",
      "ftp://motion.example.test",
    ]) {
      expect(() => parseMotionCallbackUrl(raw), raw).toThrow(/MOTION_CALLBACK_URL/);
    }
  });
});

describe("motion doorbell channel", () => {
  describe("addressing", () => {
    it("rings for a motion session's terminal statuses, with the ref as recipient", async () => {
      const { channel } = harness();
      expect(channel.isEnabled({ ...NOTIFICATION_DEFAULTS, channels: { teams: false } })).toBe(
        true
      );
      expect(await channel.address(settled())).toEqual([
        { recipientRef: REF, payload: VECTOR_1.body },
      ]);
      for (const status of ["failed", "cancelled", "archived"] as const) {
        const [address] = await channel.address(settled({ status }));
        expect(JSON.parse(address!.payload)).toMatchObject({ status });
      }
    });

    it("stays silent without a motion external ref", async () => {
      const { channel } = harness();
      expect(await channel.address(settled({ externalRef: null }))).toEqual([]);
      expect(
        await channel.address(settled({ externalRef: { service: "linear", ref: REF } }))
      ).toEqual([]);
      expect(
        await channel.address(settled({ externalRef: { service: "motion", ref: "bad ref" } }))
      ).toEqual([]);
    });

    it("carries no title, owner, repository, PR or reason, even when the envelope has them", async () => {
      const { channel } = harness();
      const [address] = await channel.address(
        settled({
          envelope: {
            sessionId: SESSION,
            status: "completed",
            reason: "completed",
            repo: "acme/widgets",
            prNumber: 42,
            prUrl: "https://github.com/acme/widgets/pull/42",
            activeDurationMs: 60_000,
            resetsAtMs: null,
          },
        })
      );
      expect(Object.keys(JSON.parse(address!.payload))).toEqual([
        "type",
        "sessionId",
        "externalRef",
        "status",
        "revision",
        "occurredAt",
      ]);
      expect(address!.payload).not.toMatch(/acme|github|user-owner/);
    });
  });

  describe("delivery", () => {
    it("posts the stored bytes, sig1-signed as open-inspect, with no actor", async () => {
      const { channel, sent } = harness();
      expect(await channel.deliver(claimed(VECTOR_1.body), VECTOR_1.timestampMs)).toEqual({
        kind: "sent",
      });
      expect(sent).toEqual([
        {
          url: `https://motion.example.test${MOTION_DOORBELL_PATH}`,
          headers: {
            "content-type": "application/json",
            "x-openinspect-service": "open-inspect",
            "x-openinspect-service-signature": VECTOR_1.header,
          },
          body: VECTOR_1.body,
        },
      ]);
    });

    it("signs each attempt afresh over the same bytes", async () => {
      const { channel, sent, clock } = harness(async () => new Response(null, { status: 503 }));
      await channel.deliver(claimed(VECTOR_1.body), clock.now);
      clock.now += 60_000;
      await channel.deliver(claimed(VECTOR_1.body, 2), clock.now);
      expect(sent.map((request) => request.body)).toEqual([VECTOR_1.body, VECTOR_1.body]);
      const [first, second] = sent.map(
        (request) => request.headers["x-openinspect-service-signature"]!
      );
      expect(first).toBe(VECTOR_1.header);
      expect(second).toMatch(/^sig1\.1792800060000\.aaaaaaaaaaaaaaaa\.[0-9a-f]{64}$/);
      expect(second).not.toBe(first);
    });

    it.each([
      [202, { kind: "sent" }],
      [200, { kind: "sent" }],
      [404, { kind: "permanent", code: "receiver_off" }],
      [400, { kind: "permanent", code: "http_400" }],
      [401, { kind: "permanent", code: "http_401" }],
      [403, { kind: "permanent", code: "http_403" }],
      [405, { kind: "permanent", code: "http_405" }],
      [413, { kind: "permanent", code: "http_413" }],
      [409, { kind: "permanent", code: "http_409" }],
      [302, { kind: "permanent", code: "http_302" }],
      [408, { kind: "retryable", code: "http_408" }],
      [429, { kind: "retryable", code: "http_429" }],
      [500, { kind: "retryable", code: "http_500" }],
      [503, { kind: "retryable", code: "http_503" }],
    ])("maps motion's %i", async (status, outcome) => {
      const { channel } = harness(async () => new Response(null, { status }));
      expect(await channel.deliver(claimed(VECTOR_1.body), VECTOR_1.timestampMs)).toEqual(outcome);
    });

    it("waits out Retry-After, capped", async () => {
      const { channel } = harness(
        async () => new Response(null, { status: 429, headers: { "Retry-After": "90" } })
      );
      expect(await channel.deliver(claimed(VECTOR_1.body), VECTOR_1.timestampMs)).toEqual({
        kind: "retryable",
        code: "http_429",
        retryAfterMs: 90_000,
      });
      const capped = harness(
        async () => new Response(null, { status: 503, headers: { "Retry-After": "86400" } })
      );
      expect(await capped.channel.deliver(claimed(VECTOR_1.body), VECTOR_1.timestampMs)).toEqual({
        kind: "retryable",
        code: "http_503",
        retryAfterMs: MOTION_DOORBELL_MAX_RETRY_AFTER_MS,
      });
    });

    it("retries a network error and a timeout", async () => {
      const network = harness(async () => {
        throw new TypeError("fetch failed");
      });
      expect(await network.channel.deliver(claimed(VECTOR_1.body), VECTOR_1.timestampMs)).toEqual({
        kind: "retryable",
        code: "network",
      });
      const timeout = harness(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      });
      expect(await timeout.channel.deliver(claimed(VECTOR_1.body), VECTOR_1.timestampMs)).toEqual({
        kind: "retryable",
        code: "timeout",
      });
    });

    it("refuses a stored payload that is not the closed body, without sending", async () => {
      const { channel, sent } = harness();
      const extra = VECTOR_1.body.replace("}", ',"title":"Acme client secret plan"}');
      for (const payload of [extra, "not json", '{"type":"session.settled"}']) {
        expect(await channel.deliver(claimed(payload), VECTOR_1.timestampMs)).toEqual({
          kind: "permanent",
          code: "invalid_payload",
        });
      }
      expect(sent).toEqual([]);
    });

    it("logs ids and the outcome only, never the body", async () => {
      const { channel, log } = harness(async () => new Response("motion detail", { status: 401 }));
      await channel.deliver(claimed(VECTOR_1.body), VECTOR_1.timestampMs);
      const logged = JSON.stringify(vi.mocked(log.warn).mock.calls);
      expect(logged).toContain("notifications.motion_doorbell");
      expect(logged).not.toContain(REF);
      expect(logged).not.toContain("motion detail");
      expect(logged).not.toContain(VECTOR_1.secret);
    });
  });
});
