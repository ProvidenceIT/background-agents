import { computeHmacHex } from "@open-inspect/shared/auth";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import type { Env } from "../types";
import {
  runAuthHomeNotices,
  runAuthHomeNoticesJob,
  teamsDirectMessageSender,
  utcWeekStart,
  type DirectMessagePayload,
} from "./expiry-digest";
import { UserAuthHomeStore } from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER_OID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const COLLEAGUE_OID = "11111111-2222-3333-4444-555555555555";
/** A placeholder standing in for the token file's contents; it must never travel. */
const TOKEN_PLACEHOLDER = "sk-ant-oat01-placeholder";
const SECRET = "placeholder-teams-bot-secret";
/** Wednesday 2026-10-07 10:00 UTC. */
const WEDNESDAY = Date.UTC(2026, 9, 7, 10);
/** Monday 2026-10-05, the week the digest test reports. */
const WEEK_START = Date.UTC(2026, 9, 5);

const silent: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => silent,
} as unknown as Logger;

describe("subscription-home notices", () => {
  let db: NodeSqlDatabase;
  let sent: DirectMessagePayload[];
  let accept: boolean;
  const send = async (payload: DirectMessagePayload) => {
    if (!accept) return false;
    sent.push(payload);
    return true;
  };

  beforeEach(async () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    db = createNodeSqlDatabase(sqlite);
    sent = [];
    accept = true;
    await db.batch([
      db.prepare(
        `INSERT INTO users (id, display_name, email, created_at, updated_at) VALUES
           ('U1', 'Bram Dokman', 'owner@example.test', 1, 1),
           ('U2', 'Colleague Name', 'colleague@example.test', 1, 1),
           ('U3', 'Issue Author', NULL, 1, 1)`
      ),
      db.prepare(
        `INSERT INTO user_identities (id, user_id, provider, provider_user_id, created_at) VALUES
           ('i1', 'U1', 'microsoft', '${OWNER_OID}', 1),
           ('i2', 'U2', 'microsoft', '${COLLEAGUE_OID}', 1),
           ('i3', 'U1', 'github', '4242', 1)`
      ),
    ]);
  });
  afterEach(() => db.close());

  function registerHome(claudeExpiresAt: number | null) {
    return new UserAuthHomeStore(db).register({
      id: "H1",
      ownerUserIds: ["U1"],
      pvcName: "sf-home-bram",
      nodeName: "agent.dokman.io",
      providers: ["anthropic"],
      shared: true,
      sharingConsentAt: 1,
      claudeExpiresAt,
      now: Date.UTC(2026, 8, 1),
    });
  }

  it("weeks start on Monday 00:00 UTC", () => {
    expect(utcWeekStart(WEDNESDAY)).toBe(WEEK_START);
    expect(utcWeekStart(WEEK_START)).toBe(WEEK_START);
    expect(utcWeekStart(WEEK_START - 1)).toBe(WEEK_START - 7 * DAY_MS);
  });

  it("sends one expiry notice to the owner's Teams identity 13 days ahead, and none the next day", async () => {
    const expiresAt = WEDNESDAY + 13 * DAY_MS;
    await registerHome(expiresAt);

    await expect(runAuthHomeNotices(db, send, silent, WEDNESDAY)).resolves.toEqual({
      expiryNotices: 1,
      digests: 0,
    });
    await expect(runAuthHomeNotices(db, send, silent, WEDNESDAY + DAY_MS)).resolves.toEqual({
      expiryNotices: 0,
      digests: 0,
    });

    expect(sent).toEqual([
      {
        kind: "msteams.direct_message",
        notificationId: `auth-home:H1:claude_expiry:${expiresAt}`,
        recipientAadObjectId: OWNER_OID,
        text:
          "The Claude setup token in your subscription home expires on 2026-10-20 (in 13 days). " +
          "Claude sessions on your home are refused once it has expired. Mint a new token on your " +
          "PC with `claude setup-token` and copy it into the home with the enrolment script; " +
          "Settings > Subscription homes shows the new expiry once a session has mounted the home.",
        timestamp: WEDNESDAY,
      },
    ]);
  });

  it("stays quiet while the expiry is further than 14 days or unknown, and notices a re-minted token anew", async () => {
    await registerHome(WEDNESDAY + 15 * DAY_MS);
    await runAuthHomeNotices(db, send, silent, WEDNESDAY);
    expect(sent).toEqual([]);

    await runAuthHomeNotices(db, send, silent, WEDNESDAY + 2 * DAY_MS);
    expect(sent.map((payload) => payload.notificationId)).toEqual([
      `auth-home:H1:claude_expiry:${WEDNESDAY + 15 * DAY_MS}`,
    ]);

    // The owner re-minted; a sandbox reported the new expiry, a year out, then
    // that one comes within 14 days too.
    const renewed = WEDNESDAY + 380 * DAY_MS;
    await db
      .prepare("UPDATE user_auth_homes SET claude_expires_at = ? WHERE id = 'H1'")
      .bind(renewed)
      .run();
    await runAuthHomeNotices(db, send, silent, WEDNESDAY + 3 * DAY_MS);
    await runAuthHomeNotices(db, send, silent, renewed - 10 * DAY_MS);
    expect(sent.map((payload) => payload.notificationId)).toEqual([
      `auth-home:H1:claude_expiry:${WEDNESDAY + 15 * DAY_MS}`,
      `auth-home:H1:claude_expiry:${renewed}`,
    ]);
  });

  it("gives the claim back when the bot does not accept the notice, so the next tick retries", async () => {
    await registerHome(WEDNESDAY + 13 * DAY_MS);
    accept = false;
    await expect(runAuthHomeNotices(db, send, silent, WEDNESDAY)).resolves.toMatchObject({
      expiryNotices: 0,
    });
    accept = true;
    await expect(runAuthHomeNotices(db, send, silent, WEDNESDAY + 60_000)).resolves.toMatchObject({
      expiryNotices: 1,
    });
    expect(sent).toHaveLength(1);
  });

  it("digests a week of 3 own and 2 shared-served sessions per kind and per person, once", async () => {
    await registerHome(null);
    const at = (day: number) => WEEK_START + day * DAY_MS + 3_600_000;
    const sessions: [string, string, string, string, string | null, number][] = [
      // id, selection, kind, actor, work-item author, created_at
      ["s1", "own", "prompt", "U1", null, at(0)],
      ["s2", "own", "prompt", "U1", null, at(1)],
      ["s3", "own", "pr_event", "U1", "U3", at(2)],
      ["s4", "shared", "prompt", "U2", null, at(3)],
      ["s5", "shared", "schedule", "U2", null, at(6)],
      // Outside the week, and on no home: not in the digest.
      ["s6", "own", "prompt", "U1", null, WEEK_START - 1],
      ["s7", "own", "prompt", "U1", null, WEEK_START + 7 * DAY_MS],
    ];
    for (const [id, selection, kind, actor, author, createdAt] of sessions) {
      await db
        .prepare(
          `INSERT INTO sessions (id, user_id, trigger_actor_user_id, trigger_kind,
             work_item_author_user_id, auth_home_id, auth_home_selection, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'H1', ?, ?, ?)`
        )
        .bind(id, actor, actor, kind, author, selection, createdAt, createdAt)
        .run();
    }
    await db
      .prepare(
        `INSERT INTO sessions (id, user_id, trigger_actor_user_id, trigger_kind, created_at, updated_at)
         VALUES ('s8', 'U2', 'U2', 'prompt', ?, ?)`
      )
      .bind(at(2), at(2))
      .run();

    const mondayBeforeSeven = WEEK_START + 7 * DAY_MS + 6 * 3_600_000;
    await expect(runAuthHomeNotices(db, send, silent, mondayBeforeSeven)).resolves.toEqual({
      expiryNotices: 0,
      digests: 1,
    });
    // That was the week before (s6 only); the reported week is due from 07:00.
    expect(sent.map((payload) => payload.notificationId)).toEqual([
      "auth-home:H1:weekly_digest:2026-09-28",
    ]);
    sent = [];

    const mondayEight = WEEK_START + 7 * DAY_MS + 8 * 3_600_000;
    await runAuthHomeNotices(db, send, silent, mondayEight);
    await runAuthHomeNotices(db, send, silent, mondayEight + DAY_MS);

    expect(sent).toEqual([
      {
        kind: "msteams.direct_message",
        notificationId: "auth-home:H1:weekly_digest:2026-10-05",
        recipientAadObjectId: OWNER_OID,
        text: [
          "**Subscription home, week of 2026-10-05 to 2026-10-11 (UTC):** 5 sessions.",
          "",
          "By kind: prompt 3, pr_event 1, schedule 1",
          "",
          "By person:",
          "- Bram Dokman (you), own: 3 (prompt 2, pr_event 1)",
          "- Colleague Name, on your shared home: 2 (prompt 1, schedule 1)",
          "",
          "Work items by others:",
          "- Issue Author: 1",
        ].join("\n"),
        timestamp: mondayEight,
      },
    ]);
    const wire = JSON.stringify(sent);
    for (const forbidden of ["sf-home-bram", "agent.dokman.io", TOKEN_PLACEHOLDER, "oauth"]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it("sends no digest for an empty week and nothing to an owner without a Teams identity", async () => {
    await new UserAuthHomeStore(db).register({
      id: "H3",
      ownerUserIds: ["U3"],
      pvcName: "sf-home-author",
      nodeName: "agent.dokman.io",
      providers: ["anthropic"],
      claudeExpiresAt: WEDNESDAY + DAY_MS,
      now: Date.UTC(2026, 8, 1),
    });
    await registerHome(null);
    await runAuthHomeNotices(db, send, silent, WEDNESDAY);
    await runAuthHomeNotices(db, send, silent, WEDNESDAY + 60_000);
    expect(sent).toEqual([]);
    const settled = await db
      .prepare("SELECT home_id, kind, sent_at FROM auth_home_notices ORDER BY home_id, kind")
      .all();
    expect(settled.results).toEqual([
      { home_id: "H1", kind: "weekly_digest", sent_at: WEDNESDAY },
      { home_id: "H3", kind: "claude_expiry", sent_at: WEDNESDAY },
      { home_id: "H3", kind: "weekly_digest", sent_at: WEDNESDAY },
    ]);
  });

  it("signs the bot callback as the control plane signs callbacks, and is a no-op without the bot", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const bot = {
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json({ ok: true, outcome: "delivered" });
      },
    };
    const payload: DirectMessagePayload = {
      kind: "msteams.direct_message",
      notificationId: "auth-home:H1:claude_expiry:1",
      recipientAadObjectId: OWNER_OID,
      text: "hello",
      timestamp: WEDNESDAY,
    };
    await expect(teamsDirectMessageSender(bot, SECRET, silent)(payload)).resolves.toBe(true);
    expect(requests).toEqual([
      {
        url: "https://internal/callbacks/direct_message",
        body: { ...payload, signature: await computeHmacHex(JSON.stringify(payload), SECRET) },
      },
    ]);

    await registerHome(WEDNESDAY + DAY_MS);
    await runAuthHomeNoticesJob({} as Env, db, silent, WEDNESDAY);
    await runAuthHomeNoticesJob(
      { SERVICE_AUTH_SECRET_TEAMS_BOT: SECRET } as Env,
      db,
      silent,
      WEDNESDAY
    );
    expect(requests).toHaveLength(1);
    await runAuthHomeNoticesJob(
      { SERVICE_AUTH_SECRET_TEAMS_BOT: SECRET, TEAMS_BOT: bot } as unknown as Env,
      db,
      silent,
      WEDNESDAY
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toMatchObject({ recipientAadObjectId: OWNER_OID });
  });
});
