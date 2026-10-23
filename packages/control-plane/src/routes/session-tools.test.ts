import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentNoticeSchema } from "@open-inspect/shared/notices";
import type { SessionToolGate } from "@open-inspect/shared/session-tools";
import type { NotificationSettings } from "@open-inspect/shared/types/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectMessagePayload } from "../auth-homes/expiry-digest";
import { IntegrationSettingsStore } from "../db/integration-settings";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { drainSessionNotices } from "../notifications/drainer";
import { SessionNoticeStore } from "../notifications/notice-store";
import {
  OWNER_OID,
  seedOwner,
  seedSession,
  silentLogger,
} from "../notifications/notifications.test-support";
import { NoticeChannelRegistry } from "../notifications/registry";
import { teamsAgentNoticeChannel } from "../notifications/senders/teams-agent";
import { openSessionToolGates } from "../session-tools/gates";
import type { MotionTaskClient, MotionTaskView } from "../session-tools/motion-client";
import {
  NOTIFY_USER_MIN_INTERVAL_MS,
  NOTIFY_USER_SESSION_QUOTA,
} from "../session-tools/notify-user";
import type { Env } from "../types";
import { createMotionTaskHandlers, handleNotifyUser } from "./session-tools";
import type { SandboxRouteContext } from "./shared";

const SESSION = "9f2c4e1a7b3d5f60a1b2c3d4e5f60718";
const MOTION_SESSION = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const TITLE = "Acme client secret plan";
const NOW = Date.UTC(2026, 9, 23, 12);
const MOTION_REF = { service: "motion", ref: "providence/delegated-work/dw_123" };

function migratedDatabase(): NodeSqlDatabase {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(
    sqlite,
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
  );
  return createNodeSqlDatabase(sqlite);
}

const FULL_ENV = {
  TEAMS_BOT: { fetch: vi.fn() },
  SERVICE_AUTH_SECRET_TEAMS_BOT: "teams-secret",
  WEB_APP_URL: "https://oi.example.test",
  MOTION_API_URL: "https://motion.example.test",
  MOTION_API_KEY: "mk_test",
} as unknown as Env;

describe("session tool routes", () => {
  let db: NodeSqlDatabase;
  let ctx: SandboxRouteContext;

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    db = migratedDatabase();
    ctx = { db, request_id: "req-1", trace_id: "trace-1" } as unknown as SandboxRouteContext;
    await seedOwner(db);
    await seedSession(db, SESSION);
    await seedSession(db, MOTION_SESSION, { externalRef: MOTION_REF });
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  async function enable(tools: SessionToolGate[], enabledRepos?: string[]) {
    await new IntegrationSettingsStore(db).setGlobal("session-tools", {
      ...(enabledRepos ? { enabledRepos } : {}),
      defaults: { tools },
    });
  }

  async function notifications(settings: NotificationSettings) {
    await new IntegrationSettingsStore(db).setGlobal("notifications", { defaults: settings });
  }

  async function rows() {
    return (
      await db
        .prepare(
          "SELECT session_id, revision, status, channel, recipient_ref, reason_code, state, payload FROM session_notices ORDER BY id"
        )
        .all<Record<string, unknown>>()
    ).results;
  }

  describe("gates", () => {
    it("opens nothing by default", async () => {
      const target = { sessionId: MOTION_SESSION, repoOwner: "acme", repoName: "widgets" };
      expect(await openSessionToolGates(db, FULL_ENV, target)).toEqual([]);
    });

    it("opens only what the deployment can serve and the session qualifies for", async () => {
      await enable(["notify", "motion_read", "motion_write"]);
      const plain = { sessionId: SESSION, repoOwner: "acme", repoName: "widgets" };
      const motion = { ...plain, sessionId: MOTION_SESSION };
      expect(await openSessionToolGates(db, FULL_ENV, plain)).toEqual(["notify"]);
      expect(await openSessionToolGates(db, FULL_ENV, motion)).toEqual([
        "motion_read",
        "motion_write",
        "notify",
      ]);
      const bare = {} as Env;
      expect(await openSessionToolGates(db, bare, motion)).toEqual([]);
    });

    it("honours the repository allowlist", async () => {
      await enable(["notify"], ["acme/other"]);
      expect(
        await openSessionToolGates(db, FULL_ENV, {
          sessionId: SESSION,
          repoOwner: "acme",
          repoName: "widgets",
        })
      ).toEqual([]);
    });
  });

  describe("POST /sessions/:id/notify", () => {
    const notify = (body: unknown, env: Env = FULL_ENV, id = SESSION) =>
      handleNotifyUser(
        new Request(`https://cp.test/sessions/${id}/notify`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
        env,
        { id },
        ctx
      );

    it("refuses while the gate is closed, which is the default", async () => {
      await notifications({ enabled: true, mode: "live" });
      const response = await notify({ message: "PR ready" });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ reason: "feature_disabled" });
      expect(await rows()).toEqual([]);
    });

    it("refuses without a Teams bot, whatever the settings say", async () => {
      await enable(["notify"]);
      await notifications({ enabled: true, mode: "live" });
      const env = { ...FULL_ENV, TEAMS_BOT: undefined } as Env;
      expect((await notify({ message: "PR ready" }, env)).status).toBe(403);
    });

    it("refuses while owner notices are off", async () => {
      await enable(["notify"]);
      const response = await notify({ message: "PR ready" });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ reason: "notifications_off" });
    });

    describe("when enabled and live", () => {
      beforeEach(async () => {
        await enable(["notify"]);
        await notifications({ enabled: true, mode: "live" });
      });

      it("queues a cleaned DM to the owner of a private session, never to anyone else", async () => {
        const response = await notify({
          message:
            "<at>Sam</at> PR ready https://github.com/acme/widgets/pull/7 [x](https://evil.example)",
          urgency: "high",
        });
        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({ status: "queued", remaining: 4 });
        const [row] = await rows();
        expect(row).toMatchObject({
          session_id: SESSION,
          revision: 1,
          status: "agent",
          channel: "teams-agent",
          recipient_ref: OWNER_OID,
          reason_code: "agent_high",
          state: "pending",
        });
        const payload = agentNoticeSchema.parse(JSON.parse(row!.payload as string));
        expect(payload).toMatchObject({
          kind: "agent",
          repo: "acme/widgets",
          urgency: "high",
          text: "PR ready https://github.com/acme/widgets/pull/7 x",
          textLength: 49,
        });
        expect(row!.payload).not.toContain(TITLE);
      });

      it("never lets the agent name a recipient", async () => {
        const response = await notify({ message: "hi", recipient: "ceo@example.com" });
        expect(response.status).toBe(400);
        expect(await rows()).toEqual([]);
      });

      it("allows one notice a minute and five per session", async () => {
        expect((await notify({ message: "one" })).status).toBe(202);
        const soon = await notify({ message: "two" });
        expect(soon.status).toBe(429);
        expect(await soon.json()).toMatchObject({ reason: "too_soon", retryAfter: 60 });
        for (let sent = 1; sent < NOTIFY_USER_SESSION_QUOTA; sent += 1) {
          vi.setSystemTime(NOW + sent * NOTIFY_USER_MIN_INTERVAL_MS);
          expect((await notify({ message: `n${sent}` })).status).toBe(202);
        }
        vi.setSystemTime(NOW + 10 * NOTIFY_USER_MIN_INTERVAL_MS);
        const over = await notify({ message: "six" });
        expect(over.status).toBe(429);
        expect(await over.json()).toMatchObject({ reason: "quota_exceeded" });
        expect(await rows()).toHaveLength(NOTIFY_USER_SESSION_QUOTA);
      });

      it("refuses a child session and a message that is empty once cleaned", async () => {
        await db
          .prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?")
          .bind(MOTION_SESSION, SESSION)
          .run();
        expect(await (await notify({ message: "hi" })).json()).toMatchObject({
          reason: "child_session",
        });
        await db.prepare("UPDATE sessions SET parent_session_id = NULL").run();
        const empty = await notify({ message: "<at>Sam</at> <b> </b>" });
        expect(empty.status).toBe(422);
        expect(await rows()).toEqual([]);
      });

      it("sends the words once, then keeps only their hash and length", async () => {
        await notify({ message: "Blocked on the staging database password." });
        const posted: DirectMessagePayload[] = [];
        const registry = new NoticeChannelRegistry([
          teamsAgentNoticeChannel({
            post: async (payload) => {
              posted.push(payload);
              return { ok: true };
            },
            webAppUrl: "https://oi.example.test",
          }),
        ]);
        const store = new SessionNoticeStore(db);
        expect(await drainSessionNotices(store, registry, silentLogger(), NOW + 1)).toEqual({
          sent: 1,
          failed: 0,
          retried: 0,
        });
        expect(posted).toEqual([
          expect.objectContaining({
            recipientAadObjectId: OWNER_OID,
            text: [
              "From your Open-Inspect agent in acme/widgets:",
              "Blocked on the staging database password.",
              `https://oi.example.test/session/${SESSION}`,
            ].join("\n"),
          }),
        ]);
        const [row] = await rows();
        expect(row!.state).toBe("sent");
        const kept = JSON.parse(row!.payload as string);
        expect(kept).not.toHaveProperty("text");
        expect(kept).toMatchObject({
          textLength: 41,
          textSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
      });
    });

    it("records a text-free row in shadow mode", async () => {
      await enable(["notify"]);
      await notifications({ enabled: true, mode: "shadow" });
      const response = await notify({ message: "PR ready" });
      expect(await response.json()).toMatchObject({ status: "recorded" });
      const [row] = await rows();
      expect(row!.state).toBe("shadow");
      expect(JSON.parse(row!.payload as string)).not.toHaveProperty("text");
    });
  });

  describe("motion routes", () => {
    const TASK: MotionTaskView = {
      id: "task_1",
      title: "Fix the invoice export",
      description: "CSV totals are off by one cent.",
      status: "IN_PROGRESS",
      priority: "HIGH",
      dueDate: null,
      project: "Billing",
      labels: ["bug"],
      subtasks: [],
    };
    let calls: Array<[string, string, unknown?]>;
    let fake: MotionTaskClient;

    beforeEach(() => {
      calls = [];
      fake = {
        getTask: async (id) => {
          calls.push(["getTask", id]);
          return { ok: true, value: TASK };
        },
        addNote: async (id, note) => {
          calls.push(["addNote", id, note]);
          return { ok: true, value: { noteId: "note_1" } };
        },
      };
    });

    const handlers = () => createMotionTaskHandlers(() => fake);
    const getTask = (id = MOTION_SESSION) =>
      handlers().getTask(
        new Request(`https://cp.test/sessions/${id}/motion/task`),
        FULL_ENV,
        { id },
        ctx
      );
    const addNote = (body: unknown, id = MOTION_SESSION) =>
      handlers().addNote(
        new Request(`https://cp.test/sessions/${id}/motion/notes`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
        FULL_ENV,
        { id },
        ctx
      );

    it("refuses both while their gates are closed", async () => {
      expect((await getTask()).status).toBe(403);
      expect((await addNote({ title: "t", content: "c" })).status).toBe(403);
      expect(calls).toEqual([]);
    });

    it("reads the Task of this session's delegated work only", async () => {
      await enable(["motion_read"]);
      const response = await getTask();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(TASK);
      expect(calls).toEqual([["getTask", "dw_123"]]);
      expect((await addNote({ title: "t", content: "c" })).status).toBe(403);
    });

    it("refuses a session motion did not start, even with the gates open", async () => {
      await enable(["motion_read", "motion_write"]);
      expect((await getTask(SESSION)).status).toBe(403);
      expect(calls).toEqual([]);
    });

    it("adds a note with only a title and content", async () => {
      await enable(["motion_write"]);
      expect(
        (await addNote({ title: "t", content: "c", taskId: "other", status: "DONE" })).status
      ).toBe(400);
      const response = await addNote({ title: "Findings", content: "Rounding in export.ts" });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ status: "added", noteId: "note_1" });
      expect(calls).toEqual([
        ["addNote", "dw_123", { title: "Findings", content: "Rounding in export.ts" }],
      ]);
    });

    it("maps motion's failures to fixed answers", async () => {
      await enable(["motion_read"]);
      fake.getTask = async () => ({ ok: false, reason: "unauthorized" });
      const response = await getTask();
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ reason: "unauthorized" });
    });
  });
});
