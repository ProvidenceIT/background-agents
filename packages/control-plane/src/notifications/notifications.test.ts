import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { noticeEnvelopeSchema } from "@open-inspect/shared/notices";
import {
  resolveNotificationSettings,
  type NotificationSettings,
} from "@open-inspect/shared/types/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectMessageDelivery, DirectMessagePayload } from "../auth-homes/expiry-digest";
import { IntegrationSettingsStore } from "../db/integration-settings";
import { SessionIndexStore } from "../db/session-index";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import type { BackgroundTasks } from "../platform-ports";
import type { Env } from "../types";
import {
  NOTICE_MAX_AGE_MS,
  NOTICE_MAX_ATTEMPTS,
  drainSessionNotices,
  runSessionNoticesJob,
} from "./drainer";
import { SessionNoticeStore } from "./notice-store";
import {
  OWNER,
  OWNER_OID,
  seedOwner,
  seedSession,
  silentLogger,
} from "./notifications.test-support";
import {
  SessionNoticeRecorder,
  loadNotificationSettings,
  recordSessionNotices,
  settledSessionFacts,
  type SettlementReading,
  type SettlementSource,
} from "./recorder";
import { NoticeChannelRegistry, type SettledSessionFacts } from "./registry";
import { createNoticeChannelRegistry } from "./channels";
import {
  MOTION_DOORBELL_MAX_AGE_MS,
  MOTION_NOTICE_CHANNEL,
  motionDoorbellChannel,
} from "./senders/motion-doorbell";
import { teamsDirectMessageChannel, WATCHED_TURN_NOTICE_MIN_MS } from "./senders/teams-dm";

const SESSION = "9f2c4e1a7b3d5f60a1b2c3d4e5f60718";
const TITLE = "Acme client secret plan";
const NOW = Date.UTC(2026, 9, 23, 12);
const OCCURRED_AT_MS = NOW - 2_000;
const LIVE = resolveNotificationSettings({ enabled: true, mode: "live" });

function migratedDatabase(): NodeSqlDatabase {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(
    sqlite,
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
  );
  return createNodeSqlDatabase(sqlite);
}

function reading(overrides: Partial<SettlementReading> = {}): SettlementReading {
  return {
    session: { repo_owner: "acme", repo_name: "widgets", spawn_source: "user" },
    publicSessionId: SESSION,
    status: "completed",
    revision: 7,
    occurredAtMs: OCCURRED_AT_MS,
    latestTerminalMessage: { source: "web", callback_context: null },
    artifacts: [],
    activeDurationMs: 12 * 60 * 1000,
    lastTurnDurationMs: 60 * 1000,
    lastTurnLimit: null,
    shutdown: null,
    watchingUserIds: [],
    ...overrides,
  };
}

describe("settledSessionFacts", () => {
  it("builds the closed envelope from the repo, newest PR and active time", () => {
    const facts = settledSessionFacts(
      reading({
        artifacts: [
          { type: "branch", url: "https://github.com/acme/widgets/tree/x", metadata: null },
          {
            type: "pr",
            url: "https://github.com/acme/widgets/pull/42",
            metadata: JSON.stringify({ number: 42, title: TITLE }),
          },
          {
            type: "pr",
            url: "https://github.com/acme/widgets/pull/41",
            metadata: JSON.stringify({ number: 41 }),
          },
        ],
      })
    );
    expect(facts).toEqual({
      sessionId: SESSION,
      status: "completed",
      occurredAtMs: OCCURRED_AT_MS,
      envelope: {
        sessionId: SESSION,
        status: "completed",
        reason: "completed",
        repo: "acme/widgets",
        prNumber: 42,
        prUrl: "https://github.com/acme/widgets/pull/42",
        activeDurationMs: 12 * 60 * 1000,
        resetsAtMs: null,
      },
      revision: 7,
      spawnSource: "user",
      repliedInChatThread: false,
      watchingUserIds: [],
      lastTurnDurationMs: 60 * 1000,
    });
    expect(noticeEnvelopeSchema.parse(facts.envelope)).toEqual(facts.envelope);
  });

  it("owes the owner nothing for a cancel or an archive", () => {
    for (const status of ["cancelled", "archived"] as const) {
      expect(settledSessionFacts(reading({ status }))).toMatchObject({ status, envelope: null });
    }
  });

  it("names a usage limit with its reset, and a held sandbox above it", () => {
    const limit = {
      kind: "subscription_limit" as const,
      window: "five_hour" as const,
      resetsAtMs: NOW + 3_600_000,
      subscriptionSlot: null,
      harness: "claude",
    };
    expect(
      settledSessionFacts(reading({ status: "failed", lastTurnLimit: limit })).envelope
    ).toMatchObject({ reason: "limit_hit", resetsAtMs: NOW + 3_600_000 });
    expect(settledSessionFacts(reading({ status: "failed" })).envelope).toMatchObject({
      reason: "failed",
      resetsAtMs: null,
    });
    expect(
      settledSessionFacts(
        reading({
          status: "failed",
          lastTurnLimit: limit,
          shutdown: { phase: "failed", expiresAtMs: null, drainAtMs: null },
        })
      ).envelope
    ).toMatchObject({ reason: "recovery_needed", resetsAtMs: null });
  });

  it("drops a PR link that is not https and marks a turn that came from a Teams thread", () => {
    const facts = settledSessionFacts(
      reading({
        artifacts: [{ type: "pr", url: "http://example.test/pr/1", metadata: '{"number":1}' }],
        latestTerminalMessage: { source: "msteams", callback_context: "{}" },
      })
    );
    expect(facts.envelope).toMatchObject({ prNumber: null, prUrl: null });
    expect(facts.repliedInChatThread).toBe(true);
  });
});

describe("session notices", () => {
  let db: NodeSqlDatabase;
  let posted: DirectMessagePayload[];
  let reply: DirectMessageDelivery;
  const log = silentLogger();

  const registry = () =>
    new NoticeChannelRegistry([
      teamsDirectMessageChannel({
        db,
        post: async (payload) => {
          posted.push(payload);
          return reply;
        },
        log,
        webAppUrl: "https://oi.example.test/",
      }),
    ]);

  async function configure(settings: NotificationSettings | null) {
    if (settings === null) return;
    await new IntegrationSettingsStore(db).setGlobal("notifications", { defaults: settings });
  }

  async function rows() {
    return (
      await db
        .prepare(
          "SELECT session_id, revision, channel, recipient_ref, reason_code, state, payload, attempts, error_code FROM session_notices ORDER BY id"
        )
        .all<Record<string, unknown>>()
    ).results;
  }

  const facts = (overrides: Partial<SettlementReading> = {}): SettledSessionFacts =>
    settledSessionFacts(reading(overrides));

  const record = (f: SettledSessionFacts, nowMs = NOW) =>
    recordSessionNotices(f, { db, registry: registry(), nowMs });

  beforeEach(async () => {
    db = migratedDatabase();
    posted = [];
    reply = { ok: true };
    await seedOwner(db);
    await seedSession(db, SESSION);
  });
  afterEach(() => db.close());

  describe("recording", () => {
    it("writes nothing while the integration is off, which is the default", async () => {
      expect(await record(facts())).toBe(0);
      await configure({ enabled: true });
      expect(await record(facts())).toBe(0);
      await configure({ enabled: false, mode: "live" });
      expect(await record(facts())).toBe(0);
      await configure({ enabled: true, mode: "live", channels: { teams: false } });
      expect(await record(facts())).toBe(0);
      expect(await rows()).toEqual([]);
    });

    it("writes one row per revision however often the same projection repeats", async () => {
      await configure({ enabled: true, mode: "live" });
      expect(await record(facts())).toBe(1);
      expect(await record(facts())).toBe(0);
      expect(await record(facts({ revision: 8, status: "failed" }))).toBe(1);
      expect(await rows()).toEqual([
        expect.objectContaining({
          session_id: SESSION,
          revision: 7,
          channel: "teams",
          recipient_ref: OWNER_OID,
          reason_code: "completed",
          state: "pending",
        }),
        expect.objectContaining({ revision: 8, reason_code: "failed", state: "pending" }),
      ]);
    });

    it("stores the closed envelope and never the session title", async () => {
      await configure({ enabled: true, mode: "live" });
      await record(facts());
      const [row] = await rows();
      const envelope = noticeEnvelopeSchema.parse(JSON.parse(String(row!.payload)));
      expect(envelope.sessionId).toBe(SESSION);
      expect(String(row!.payload)).not.toContain(TITLE);
    });

    it("skips the Teams DM when a Teams, Slack or Linear thread already got the reply", async () => {
      await configure({ enabled: true, mode: "live" });
      expect(
        await record(
          facts({ latestTerminalMessage: { source: "msteams", callback_context: "{}" } })
        )
      ).toBe(0);
      // Slack and Linear threads got their bot's reply too: no second notice.
      for (const [revision, source] of [
        [8, "slack"],
        [9, "linear"],
      ] as const) {
        expect(
          await record(
            facts({ revision, latestTerminalMessage: { source, callback_context: "{}" } })
          )
        ).toBe(0);
      }
      // A prompt without a thread to answer still gets the DM.
      expect(
        await record(
          facts({
            revision: 10,
            latestTerminalMessage: { source: "slack", callback_context: null },
          })
        )
      ).toBe(1);
    });

    it("skips the Teams DM while the owner has the session open, not for someone else", async () => {
      await configure({ enabled: true, mode: "live" });
      expect(await record(facts({ watchingUserIds: ["user-other", OWNER] }))).toBe(0);
      expect(await record(facts({ revision: 8, watchingUserIds: ["user-other"] }))).toBe(1);
    });

    it("still DMs a watching owner when the turn ran long", async () => {
      await configure({ enabled: true, mode: "live" });
      const watching = { watchingUserIds: [OWNER] };
      expect(
        await record(facts({ ...watching, lastTurnDurationMs: WATCHED_TURN_NOTICE_MIN_MS - 1 }))
      ).toBe(0);
      expect(
        await record(
          facts({ ...watching, revision: 8, lastTurnDurationMs: WATCHED_TURN_NOTICE_MIN_MS })
        )
      ).toBe(1);
      // No start or end time counts as short.
      expect(await record(facts({ ...watching, revision: 9, lastTurnDurationMs: null }))).toBe(0);
    });

    it("tells the owner of each turn that ends while they are away", async () => {
      await configure({ enabled: true, mode: "live" });
      // Two prompts, two settles: each is a run the owner did not watch end.
      expect(await record(facts({ revision: 3 }))).toBe(1);
      expect(await record(facts({ revision: 5, watchingUserIds: [OWNER] }))).toBe(0);
      expect(await record(facts({ revision: 7, status: "failed" }))).toBe(1);
      expect((await rows()).map((row) => row.revision)).toEqual([3, 7]);
    });

    it("leaves motion's sessions to motion unless told otherwise", async () => {
      await configure({ enabled: true, mode: "live" });
      const motion = reading().session;
      expect(await record(facts({ session: { ...motion, spawn_source: "motion" } }))).toBe(0);
      await configure({ enabled: true, mode: "live", skipMotionSessions: false });
      expect(await record(facts({ session: { ...motion, spawn_source: "motion" } }))).toBe(1);
    });

    it("skips an owner without a Microsoft identity and a session without an owner", async () => {
      await configure({ enabled: true, mode: "live" });
      await db.prepare("DELETE FROM user_identities").run();
      expect(await record(facts())).toBe(0);
      await seedSession(db, "ownerless", { userId: null });
      expect(await record(facts({ publicSessionId: "ownerless" }))).toBe(0);
      expect(await rows()).toEqual([]);
    });

    it("never keeps an agent's words past live mode or the session", async () => {
      const store = new SessionNoticeStore(db);
      const agentRow = (revision: number, sessionId = SESSION) =>
        store.insert(
          {
            sessionId,
            revision,
            status: "agent",
            channel: "teams-agent",
            recipientRef: OWNER_OID,
            reasonCode: "agent",
            payload: JSON.stringify({ kind: "agent", text: "the agent's words", textLength: 17 }),
            state: "pending",
          },
          NOW
        );
      const agentRows = async () => (await rows()).filter((row) => row.channel === "teams-agent");
      await configure({ enabled: true, mode: "live" });
      await agentRow(-1);
      await seedSession(db, "deleted-session");
      await agentRow(-1, "deleted-session");

      await new SessionIndexStore(db).delete("deleted-session");
      expect(await agentRows()).toEqual([
        expect.objectContaining({ session_id: SESSION, state: "pending" }),
        expect.objectContaining({
          session_id: "deleted-session",
          state: "failed",
          error_code: "session_deleted",
          payload: JSON.stringify({ kind: "agent", textLength: 17 }),
        }),
      ]);

      await configure({ enabled: false, mode: "live" });
      await runSessionNoticesJob({} as Env, db, log, NOW);
      expect(await agentRows()).toEqual([
        expect.objectContaining({
          session_id: SESSION,
          state: "failed",
          error_code: "not_live",
          payload: JSON.stringify({ kind: "agent", textLength: 17 }),
        }),
        expect.objectContaining({ session_id: "deleted-session" }),
      ]);
    });

    it("records shadow rows that the drainer never sends", async () => {
      await configure({ enabled: true, mode: "shadow" });
      expect(await record(facts())).toBe(1);
      expect(await rows()).toEqual([expect.objectContaining({ state: "shadow" })]);
      await runSessionNoticesJob({} as Env, db, log, NOW);
      expect(
        await drainSessionNotices(new SessionNoticeStore(db), registry(), log, NOW, LIVE)
      ).toEqual({
        sent: 0,
        failed: 0,
        retried: 0,
      });
      expect(posted).toEqual([]);
    });
  });

  describe("draining", () => {
    const drain = async (nowMs = NOW) =>
      drainSessionNotices(
        new SessionNoticeStore(db),
        registry(),
        log,
        nowMs,
        await loadNotificationSettings(db)
      );

    beforeEach(async () => {
      await configure({ enabled: true, mode: "live" });
      await record(facts());
    });

    it("sends the rendered notice to the owner once, without title or agent text", async () => {
      expect(await drain()).toEqual({ sent: 1, failed: 0, retried: 0 });
      expect(await drain(NOW + 1)).toEqual({ sent: 0, failed: 0, retried: 0 });
      expect(posted).toEqual([
        {
          kind: "msteams.direct_message",
          notificationId: "session-notice:1",
          recipientAadObjectId: OWNER_OID,
          text: [
            "Your Open-Inspect session in acme/widgets completed.",
            "Active time: 12 min",
            `https://oi.example.test/session/${SESSION}`,
          ].join("\n"),
          timestamp: NOW,
        },
      ]);
      expect(posted[0]!.text).not.toContain(TITLE);
      expect(await rows()).toEqual([expect.objectContaining({ state: "sent" })]);
    });

    it("treats the bot's 403 (app not installed) as permanent", async () => {
      reply = { ok: false, httpStatus: 403 };
      expect(await drain()).toEqual({ sent: 0, failed: 1, retried: 0 });
      expect(await drain(NOW + 24 * 60 * 60 * 1000)).toEqual({ sent: 0, failed: 0, retried: 0 });
      expect(posted).toHaveLength(1);
      expect(await rows()).toEqual([
        expect.objectContaining({ state: "failed", error_code: "http_403", attempts: 1 }),
      ]);
    });

    it("retries a 503 or an unreachable bot with backoff, then gives up", async () => {
      reply = { ok: false, httpStatus: 503 };
      expect(await drain()).toEqual({ sent: 0, failed: 0, retried: 1 });
      // Not due again until the backoff has passed.
      expect(await drain(NOW + 1)).toEqual({ sent: 0, failed: 0, retried: 0 });
      reply = { ok: false, httpStatus: null, error: new Error("boom") };
      let at = NOW;
      for (let attempt = 2; attempt <= NOTICE_MAX_ATTEMPTS; attempt++) {
        at += 2 ** (attempt - 1) * 60_000;
        const result = await drain(at);
        expect(result).toEqual(
          attempt === NOTICE_MAX_ATTEMPTS
            ? { sent: 0, failed: 1, retried: 0 }
            : { sent: 0, failed: 0, retried: 1 }
        );
      }
      expect(posted).toHaveLength(NOTICE_MAX_ATTEMPTS);
      expect(await rows()).toEqual([
        expect.objectContaining({ state: "failed", error_code: "unreachable" }),
      ]);
    });

    it("drops a notice that could not go out within the hour", async () => {
      expect(await drain(NOW + NOTICE_MAX_AGE_MS + 1)).toEqual({ sent: 0, failed: 1, retried: 0 });
      expect(posted).toEqual([]);
      expect(await rows()).toEqual([expect.objectContaining({ error_code: "expired" })]);
    });

    it("fails a row whose channel this deployment no longer has", async () => {
      const result = await drainSessionNotices(
        new SessionNoticeStore(db),
        new NoticeChannelRegistry([]),
        log,
        NOW,
        LIVE
      );
      expect(result).toEqual({ sent: 0, failed: 1, retried: 0 });
      expect(await rows()).toEqual([
        expect.objectContaining({ error_code: "channel_unavailable" }),
      ]);
    });

    it("fails a waiting row whose channel the settings turned off, and drops its text", async () => {
      await configure({ enabled: true, mode: "live", channels: { teams: false } });
      expect(await drain()).toEqual({ sent: 0, failed: 1, retried: 0 });
      expect(posted).toEqual([]);
      expect(await rows()).toEqual([
        expect.objectContaining({ state: "failed", error_code: "channel_disabled" }),
      ]);
    });

    it("sends only in live mode from the scheduled job, through the configured bot", async () => {
      const requests: unknown[] = [];
      const bot = {
        fetch: vi.fn(async (_url: string, init?: RequestInit) => {
          requests.push(JSON.parse(String(init?.body)));
          return new Response("{}", { status: 200 });
        }),
      };
      const env = { TEAMS_BOT: bot, SERVICE_AUTH_SECRET_TEAMS_BOT: "secret" } as unknown as Env;
      await configure({ enabled: true, mode: "shadow" });
      await runSessionNoticesJob(env, db, log, NOW);
      expect(requests).toEqual([]);
      // Leaving live mode drops what was waiting rather than sending it later.
      expect(await rows()).toEqual([
        expect.objectContaining({ revision: 7, state: "failed", error_code: "not_live" }),
      ]);
      await configure({ enabled: true, mode: "live" });
      await record(facts({ revision: 8 }));
      await runSessionNoticesJob(env, db, log, NOW);
      expect(requests).toEqual([
        expect.objectContaining({ recipientAadObjectId: OWNER_OID, signature: expect.any(String) }),
      ]);
    });
  });
});

describe("motion doorbell notices", () => {
  const MOTION_SESSION = "00112233445566778899aabbccddeeff";
  const REF = "providence/delegated-work/cmh9z8y7x0000wxyz9876abcd";
  const log = silentLogger();
  let db: NodeSqlDatabase;
  let posted: DirectMessagePayload[];
  let pokes: Array<{ url: string; body: string; headers: Headers }>;
  let reply: () => Response;

  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    pokes.push({
      url: String(input),
      body: String(init?.body),
      headers: new Headers(init?.headers),
    });
    return reply();
  }) as typeof fetch;

  const registry = () =>
    new NoticeChannelRegistry([
      teamsDirectMessageChannel({
        db,
        post: async (payload) => {
          posted.push(payload);
          return { ok: true };
        },
        log,
      }),
      motionDoorbellChannel({
        callbackUrl: "https://motion.example.test",
        secret: "doorbell-secret",
        log,
        fetch: fetchStub,
      }),
    ]);

  const motionFacts = (overrides: Partial<SettlementReading> = {}) =>
    settledSessionFacts(
      reading({
        publicSessionId: MOTION_SESSION,
        session: { repo_owner: "acme", repo_name: "widgets", spawn_source: "motion" },
        ...overrides,
      })
    );
  const record = (f: SettledSessionFacts, nowMs = NOW) =>
    recordSessionNotices(f, { db, registry: registry(), nowMs });
  const drain = (nowMs = NOW) =>
    drainSessionNotices(new SessionNoticeStore(db), registry(), log, nowMs, LIVE);
  const configure = (settings: NotificationSettings) =>
    new IntegrationSettingsStore(db).setGlobal("notifications", { defaults: settings });
  const rows = async () =>
    (
      await db
        .prepare(
          `SELECT channel, revision, status, recipient_ref, state, payload, attempts, error_code,
             next_attempt_at FROM session_notices ORDER BY id`
        )
        .all<Record<string, unknown>>()
    ).results;

  beforeEach(async () => {
    db = migratedDatabase();
    posted = [];
    pokes = [];
    reply = () => new Response(null, { status: 202 });
    await seedOwner(db);
    await seedSession(db, MOTION_SESSION, { externalRef: { service: "motion", ref: REF } });
    await seedSession(db, SESSION);
  });
  afterEach(() => db.close());

  it("records one doorbell per revision, and leaves the Teams DM to motion by default", async () => {
    await configure({ enabled: true, mode: "live" });
    expect(await record(motionFacts())).toBe(1);
    expect(await record(motionFacts())).toBe(0);
    expect(await record(motionFacts({ revision: 8, status: "cancelled" }))).toBe(1);
    expect(await record(motionFacts({ revision: 9, status: "archived" }))).toBe(1);
    expect(await rows()).toEqual([
      expect.objectContaining({ channel: "motion", revision: 7, status: "completed" }),
      expect.objectContaining({ channel: "motion", revision: 8, status: "cancelled" }),
      expect.objectContaining({ channel: "motion", revision: 9, status: "archived" }),
    ]);
    const [first] = await rows();
    expect(first).toMatchObject({ recipient_ref: REF, state: "pending" });
    expect(JSON.parse(String(first!.payload))).toEqual({
      type: "session.settled",
      sessionId: MOTION_SESSION,
      externalRef: REF,
      status: "completed",
      revision: 7,
      occurredAt: new Date(OCCURRED_AT_MS).toISOString(),
    });
  });

  it("also DMs the owner when skipMotionSessions is off, but never for a cancel", async () => {
    await configure({ enabled: true, mode: "live", skipMotionSessions: false });
    expect(await record(motionFacts())).toBe(2);
    expect(await record(motionFacts({ revision: 8, status: "cancelled" }))).toBe(1);
    expect((await rows()).map((row) => [row.channel, row.revision])).toEqual([
      ["teams", 7],
      ["motion", 7],
      ["motion", 8],
    ]);
  });

  it("rings for no session without a motion ref, and not while the mode is off", async () => {
    await configure({ enabled: true, mode: "live", channels: { teams: false } });
    expect(await record(settledSessionFacts(reading()))).toBe(0);
    await configure({ enabled: true, mode: "off" });
    expect(await record(motionFacts())).toBe(0);
    expect(await rows()).toEqual([]);
  });

  it("records shadow doorbells and never sends them", async () => {
    await configure({ enabled: true, mode: "shadow" });
    expect(await record(motionFacts())).toBe(1);
    expect(await drain()).toEqual({ sent: 0, failed: 0, retried: 0 });
    expect(pokes).toEqual([]);
    expect(await rows()).toEqual([expect.objectContaining({ state: "shadow" })]);
  });

  it("sends the stored body once, then is done", async () => {
    await configure({ enabled: true, mode: "live" });
    await record(motionFacts());
    expect(await drain()).toEqual({ sent: 1, failed: 0, retried: 0 });
    expect(await drain(NOW + 60_000)).toEqual({ sent: 0, failed: 0, retried: 0 });
    const [row] = await rows();
    expect(pokes).toEqual([
      expect.objectContaining({
        url: "https://motion.example.test/api/v1/open-inspect/events",
        body: row!.payload,
      }),
    ]);
    expect(pokes[0]!.headers.get("x-openinspect-actor")).toBeNull();
    expect(posted).toEqual([]);
  });

  it("waits out motion's Retry-After when it is longer than the backoff", async () => {
    await configure({ enabled: true, mode: "live" });
    await record(motionFacts());
    reply = () => new Response(null, { status: 429, headers: { "Retry-After": "240" } });
    expect(await drain()).toEqual({ sent: 0, failed: 0, retried: 1 });
    expect(await rows()).toEqual([
      expect.objectContaining({ next_attempt_at: NOW + 240_000, error_code: "http_429" }),
    ]);
    expect(await drain(NOW + 120_000)).toEqual({ sent: 0, failed: 0, retried: 0 });
    reply = () => new Response(null, { status: 202 });
    expect(await drain(NOW + 240_000)).toEqual({ sent: 1, failed: 0, retried: 0 });
    expect(pokes).toHaveLength(2);
  });

  it("gives up a 401 at once, and a row motion's sweep has long covered", async () => {
    await configure({ enabled: true, mode: "live" });
    await record(motionFacts());
    await record(motionFacts({ revision: 8, status: "failed" }), NOW + 1);
    reply = () => new Response(null, { status: 401 });
    const store = new SessionNoticeStore(db);
    await store.retryLater(2, "http_503", NOW + MOTION_DOORBELL_MAX_AGE_MS, NOW);
    expect(await drain()).toEqual({ sent: 0, failed: 1, retried: 0 });
    expect(await drain(NOW + MOTION_DOORBELL_MAX_AGE_MS + 2)).toEqual({
      sent: 0,
      failed: 1,
      retried: 0,
    });
    expect(pokes).toHaveLength(1);
    expect((await rows()).map((row) => row.error_code)).toEqual(["http_401", "expired"]);
  });

  describe("configuration", () => {
    const motionEnv = {
      MOTION_CALLBACK_URL: "https://motion.example.test/",
      SERVICE_AUTH_SECRET_MOTION_CALLBACK: "doorbell-secret",
    };
    const channelIds = (env: Partial<Env>) =>
      createNoticeChannelRegistry(env as Env, db, log)
        .list()
        .map((channel) => channel.id);

    it("is absent unless both the URL and its secret are set, and valid", () => {
      expect(channelIds(motionEnv)).toEqual([MOTION_NOTICE_CHANNEL]);
      expect(channelIds({ MOTION_CALLBACK_URL: motionEnv.MOTION_CALLBACK_URL })).toEqual([]);
      expect(
        channelIds({
          SERVICE_AUTH_SECRET_MOTION_CALLBACK: motionEnv.SERVICE_AUTH_SECRET_MOTION_CALLBACK,
        })
      ).toEqual([]);
      expect(
        channelIds({ ...motionEnv, MOTION_CALLBACK_URL: "http://motion.example.test" })
      ).toEqual([]);
      // The inbound motion key does not turn the outbound doorbell on.
      expect(
        channelIds({
          MOTION_CALLBACK_URL: motionEnv.MOTION_CALLBACK_URL,
          SERVICE_AUTH_SECRET_MOTION: "x",
        })
      ).toEqual([]);
    });

    it("sends from the scheduled job through the configured URL in live mode", async () => {
      vi.stubGlobal("fetch", fetchStub);
      try {
        await configure({ enabled: true, mode: "live" });
        await record(motionFacts());
        await runSessionNoticesJob(motionEnv as Env, db, log, NOW);
        expect(pokes.map((poke) => poke.url)).toEqual([
          "https://motion.example.test/api/v1/open-inspect/events",
        ]);
        expect(pokes[0]!.headers.get("x-openinspect-service")).toBe("open-inspect");
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});

describe("SessionNoticeRecorder", () => {
  function setup() {
    const submitted: Array<{ name: string; task: () => Promise<unknown> }> = [];
    const backgroundTasks: BackgroundTasks = {
      submit: (task, metadata) => submitted.push({ name: metadata.name, task }),
    };
    const recorded: SettledSessionFacts[] = [];
    const source: SettlementSource = {
      latestTerminalMessage: () => ({ source: "web", callback_context: null }),
      artifacts: () => [],
      activeDurationMs: () => 1_000,
      lastTurnDurationMs: () => 1_000,
      lastTurnLimit: () => null,
      shutdown: () => null,
      watchingUserIds: () => ["user-watching"],
    };
    const recorder = new SessionNoticeRecorder({
      backgroundTasks,
      log: silentLogger(),
      source,
      record: async (f) => {
        recorded.push(f);
        return 1;
      },
    });
    return { recorder, submitted, recorded, source };
  }

  const root = {
    repo_owner: "acme",
    repo_name: "widgets",
    spawn_source: "user" as const,
    parent_session_id: null,
    // The row as it was before the transition: a turn was running.
    status: "active" as const,
  };

  it("records a root session that completed or failed, in the background", async () => {
    const { recorder, submitted, recorded } = setup();
    recorder.settled(root, SESSION, "completed", 3, NOW);
    recorder.settled(root, SESSION, "failed", 4, NOW);
    expect(recorded).toEqual([]);
    expect(submitted.map((entry) => entry.name)).toEqual([
      "session_notice.record",
      "session_notice.record",
    ]);
    for (const entry of submitted) await entry.task();
    expect(recorded.map((f) => [f.revision, f.envelope?.status])).toEqual([
      [3, "completed"],
      [4, "failed"],
    ]);
  });

  it("records a cancel or an archive without reading the session's storage", async () => {
    const { recorder, submitted, recorded, source } = setup();
    source.artifacts = () => {
      throw new Error("not read on a cancel or an archive");
    };
    recorder.settled(root, SESSION, "cancelled", 5, NOW);
    recorder.settled(root, SESSION, "archived", 6, NOW + 1);
    for (const entry of submitted) await entry.task();
    expect(recorded.map((f) => [f.status, f.revision, f.occurredAtMs, f.envelope])).toEqual([
      ["cancelled", 5, NOW, null],
      ["archived", 6, NOW + 1, null],
    ]);
  });

  it("owes the owner nothing when a session settles without a turn ending", async () => {
    const { recorder, submitted, recorded, source } = setup();
    source.artifacts = () => {
      throw new Error("not read when no turn ended");
    };
    // Unarchiving re-derives completed or failed from the messages of the earlier run.
    recorder.settled({ ...root, status: "archived" }, SESSION, "completed", 9, NOW);
    recorder.settled({ ...root, status: "archived" }, SESSION, "failed", 10, NOW);
    recorder.settled({ ...root, status: "created" }, SESSION, "completed", 11, NOW);
    for (const entry of submitted) await entry.task();
    // Motion's doorbell still hears of the status change; the owner does not.
    expect(recorded.map((f) => [f.status, f.revision, f.envelope])).toEqual([
      ["completed", 9, null],
      ["failed", 10, null],
      ["completed", 11, null],
    ]);
  });

  it("passes on who is watching the session and how long the turn ran", async () => {
    const { recorder, submitted, recorded } = setup();
    recorder.settled(root, SESSION, "completed", 3, NOW);
    for (const entry of submitted) await entry.task();
    expect(recorded[0]?.watchingUserIds).toEqual(["user-watching"]);
    expect(recorded[0]?.lastTurnDurationMs).toBe(1_000);
  });

  it("ignores other statuses, child sessions and health checks", () => {
    const { recorder, submitted } = setup();
    for (const status of ["created", "active"] as const) {
      recorder.settled(root, SESSION, status, 1, NOW);
    }
    recorder.settled({ ...root, parent_session_id: "parent" }, SESSION, "completed", 1, NOW);
    recorder.settled({ ...root, spawn_source: "healthcheck" }, SESSION, "completed", 1, NOW);
    expect(submitted).toEqual([]);
  });

  it("never fails the transition when the session's storage cannot be read", () => {
    const { recorder, submitted, source } = setup();
    source.artifacts = () => {
      throw new Error("storage");
    };
    expect(() => recorder.settled(root, SESSION, "completed", 1, NOW)).not.toThrow();
    expect(submitted).toEqual([]);
  });
});
