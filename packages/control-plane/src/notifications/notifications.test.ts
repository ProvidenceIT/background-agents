import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { noticeEnvelopeSchema } from "@open-inspect/shared/notices";
import type { NotificationSettings } from "@open-inspect/shared/types/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectMessageDelivery, DirectMessagePayload } from "../auth-homes/expiry-digest";
import { IntegrationSettingsStore } from "../db/integration-settings";
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
import { OWNER_OID, seedOwner, seedSession, silentLogger } from "./notifications.test-support";
import {
  SessionNoticeRecorder,
  recordSessionNotices,
  settledSessionFacts,
  type SettlementReading,
  type SettlementSource,
} from "./recorder";
import { NoticeChannelRegistry, type SettledSessionFacts } from "./registry";
import { teamsDirectMessageChannel } from "./senders/teams-dm";

const SESSION = "9f2c4e1a7b3d5f60a1b2c3d4e5f60718";
const TITLE = "Acme client secret plan";
const NOW = Date.UTC(2026, 9, 23, 12);

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
    latestTerminalMessage: { source: "web", callback_context: null },
    artifacts: [],
    activeDurationMs: 12 * 60 * 1000,
    lastTurnLimit: null,
    shutdown: null,
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
      repliedInTeamsThread: false,
    });
    expect(noticeEnvelopeSchema.parse(facts.envelope)).toEqual(facts.envelope);
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
    expect(facts.repliedInTeamsThread).toBe(true);
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

    it("skips the Teams DM when the Teams thread already got the reply", async () => {
      await configure({ enabled: true, mode: "live" });
      expect(
        await record(
          facts({ latestTerminalMessage: { source: "msteams", callback_context: "{}" } })
        )
      ).toBe(0);
      // A Slack thread is a different channel: the owner still hears on Teams.
      expect(
        await record(
          facts({ revision: 8, latestTerminalMessage: { source: "slack", callback_context: "{}" } })
        )
      ).toBe(1);
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

    it("records shadow rows that the drainer never sends", async () => {
      await configure({ enabled: true, mode: "shadow" });
      expect(await record(facts())).toBe(1);
      expect(await rows()).toEqual([expect.objectContaining({ state: "shadow" })]);
      await runSessionNoticesJob({} as Env, db, log, NOW);
      expect(await drainSessionNotices(new SessionNoticeStore(db), registry(), log, NOW)).toEqual({
        sent: 0,
        failed: 0,
        retried: 0,
      });
      expect(posted).toEqual([]);
    });
  });

  describe("draining", () => {
    const drain = (nowMs = NOW) =>
      drainSessionNotices(new SessionNoticeStore(db), registry(), log, nowMs);

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
        NOW
      );
      expect(result).toEqual({ sent: 0, failed: 1, retried: 0 });
      expect(await rows()).toEqual([
        expect.objectContaining({ error_code: "channel_unavailable" }),
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
      await configure({ enabled: true, mode: "live" });
      await runSessionNoticesJob(env, db, log, NOW);
      expect(requests).toEqual([
        expect.objectContaining({ recipientAadObjectId: OWNER_OID, signature: expect.any(String) }),
      ]);
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
      lastTurnLimit: () => null,
      shutdown: () => null,
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
  };

  it("records a root session that completed or failed, in the background", async () => {
    const { recorder, submitted, recorded } = setup();
    recorder.settled(root, SESSION, "completed", 3);
    recorder.settled(root, SESSION, "failed", 4);
    expect(recorded).toEqual([]);
    expect(submitted.map((entry) => entry.name)).toEqual([
      "session_notice.record",
      "session_notice.record",
    ]);
    for (const entry of submitted) await entry.task();
    expect(recorded.map((f) => [f.revision, f.envelope.status])).toEqual([
      [3, "completed"],
      [4, "failed"],
    ]);
  });

  it("ignores other statuses, child sessions and health checks", () => {
    const { recorder, submitted } = setup();
    for (const status of ["created", "active", "archived", "cancelled"] as const) {
      recorder.settled(root, SESSION, status, 1);
    }
    recorder.settled({ ...root, parent_session_id: "parent" }, SESSION, "completed", 1);
    recorder.settled({ ...root, spawn_source: "healthcheck" }, SESSION, "completed", 1);
    expect(submitted).toEqual([]);
  });

  it("never fails the transition when the session's storage cannot be read", () => {
    const { recorder, submitted, source } = setup();
    source.artifacts = () => {
      throw new Error("storage");
    };
    expect(() => recorder.settled(root, SESSION, "completed", 1)).not.toThrow();
    expect(submitted).toEqual([]);
  });
});
