import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import type {
  ForkHandoffResponse,
  ForkSessionResponse,
} from "@open-inspect/shared/types/session-api";
import { SessionIndexStore } from "../../src/db/session-index";
import * as repositoryResolution from "../../src/repos/resolve";
import { FORK_CONSENT_LINE } from "../../src/session/fork-handoff";
import { cleanD1Tables } from "./cleanup";
import { insertIdentity } from "./identity-seed-helpers";
import {
  initNamedSession,
  queryDO,
  seedEvents,
  seedMessage,
  serviceFetch,
  waitForSandboxStatus,
} from "./helpers";

const BASE = "https://test.local";
const MEMBER = "33333333333333333333333333333333";
const OTHER_MEMBER = "44444444444444444444444444444444";
const store = new SessionIndexStore(env.DB);

function fork(sourceId: string, body: object, userId = MEMBER) {
  return serviceFetch(`${BASE}/sessions/${sourceId}/fork`, {
    method: "POST",
    body: JSON.stringify(body),
    as: { userId, role: "member" },
  });
}

async function seedSource(): Promise<{ name: string; stub: DurableObjectStub }> {
  const name = `fork-source-${crypto.randomUUID()}`;
  const { stub } = await initNamedSession(name, {
    title: "Fix the parser",
    repoOwner: "acme",
    repoName: "web-app",
    repoId: 12345,
    defaultBranch: "main",
    userId: MEMBER,
    canonicalUserId: MEMBER,
  });
  await waitForSandboxStatus(stub, "failed");
  await queryDO(stub, "UPDATE session_repositories SET branch_name = 'oi/fix-parser'");
  const [owner] = await queryDO<{ id: string }>(
    stub,
    "SELECT id FROM participants WHERE role = 'owner'"
  );
  if (!owner) throw new Error("Expected an owner participant");
  await seedMessage(stub, {
    id: "msg-1",
    authorId: owner.id,
    content: "Fix the quote handling in the parser",
    source: "web",
    status: "failed",
    createdAt: Date.now() - 2000,
  });
  const now = Date.now();
  await seedEvents(stub, [
    {
      id: "token:msg-1",
      type: "token",
      data: JSON.stringify({
        type: "token",
        messageId: "msg-1",
        content: "The tokenizer drops escaped quotes.",
        sandboxId: "sb-1",
        timestamp: now,
      }),
      messageId: "msg-1",
      createdAt: now,
    },
    {
      id: "execution_complete:msg-1",
      type: "execution_complete",
      data: JSON.stringify({
        type: "execution_complete",
        messageId: "msg-1",
        success: false,
        error: "Claude usage limit reached",
        sandboxId: "sb-1",
        timestamp: now + 1,
      }),
      messageId: "msg-1",
      createdAt: now + 1,
    },
  ]);
  return { name, stub };
}

describe("session fork routes", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    vi.spyOn(repositoryResolution, "resolveSessionRepositories").mockImplementation(
      async (_env, repos) =>
        repos.map((repo) => ({
          ...repo,
          repoId: 12345,
          baseBranch: repo.baseBranch ?? "repo-default",
        }))
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("drafts the handoff from the stored session", async () => {
    const { name } = await seedSource();

    const response = await serviceFetch(`${BASE}/sessions/${name}/fork/handoff`, {
      as: { userId: MEMBER, role: "member" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const { handoff } = await response.json<ForkHandoffResponse>();
    expect(handoff).toContain('# Handoff from "Fix the parser"');
    expect(handoff).toContain(
      "- acme/web-app: base branch `main`; the original session pushed its work to `oi/fix-parser`. Continue from it with `git fetch origin oi/fix-parser && git reset --hard FETCH_HEAD`."
    );
    expect(handoff).toContain("## Original request\n\n> Fix the quote handling in the parser");
    expect(handoff).toContain(
      "## Recent assistant messages\n\n> The tokenizer drops escaped quotes."
    );
    expect(handoff).toContain(
      "## Where it stopped\n\nThe last turn failed: Claude usage limit reached"
    );
    expect(handoff).toContain(FORK_CONSENT_LINE);
  });

  it("creates a private fork on the source's base branch, enqueues the handoff, and replays", async () => {
    const { name, stub } = await seedSource();
    const [sourceSession] = await queryDO<{ model: string; harness: string }>(
      stub,
      "SELECT model, harness FROM session"
    );
    const forkRequestId = crypto.randomUUID();

    const response = await fork(name, { forkRequestId, handoff: "Continue the parser fix." });

    expect(response.status).toBe(201);
    const created = await response.json<ForkSessionResponse>();
    expect(created).toEqual({
      sessionId: expect.any(String),
      forkedFromSessionId: name,
      created: true,
    });
    const forkId = created.sessionId;
    expect(await store.get(forkId)).toMatchObject({
      title: "Fix the parser (fork)",
      visibility: "private",
      userId: MEMBER,
      ownerTeamId: null,
      parentSessionId: null,
      spawnDepth: 0,
      baseBranch: "main",
      model: sourceSession.model,
      harness: sourceSession.harness,
    });
    expect(
      await env.DB.prepare(
        "SELECT forked_from_session_id, fork_request_id FROM sessions WHERE id = ?"
      )
        .bind(forkId)
        .first()
    ).toEqual({ forked_from_session_id: name, fork_request_id: forkRequestId });
    await expect(store.countTotalChildren(name)).resolves.toBe(0);

    const forkStub = env.SESSION.get(env.SESSION.idFromName(forkId));
    expect(await queryDO(forkStub, "SELECT content FROM messages")).toEqual([
      { content: "Continue the parser fix." },
    ]);
    const snapshot = await serviceFetch(`${BASE}/sessions/${forkId}`, {
      as: { userId: MEMBER, role: "member" },
    });
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json<SessionSnapshot>()).session).toMatchObject({
      forkedFromSessionId: name,
      parentSessionId: null,
      repositories: [expect.objectContaining({ baseBranch: "main", branchName: null })],
    });

    const replay = await fork(name, { forkRequestId, handoff: "Something else" });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({
      sessionId: forkId,
      forkedFromSessionId: name,
      created: false,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM sessions WHERE forked_from_session_id = ?"
      )
        .bind(name)
        .first()
    ).toEqual({ count: 1 });
    await waitForSandboxStatus(forkStub, "failed");
  });

  it("builds the handoff when none is sent and applies the requested title", async () => {
    const { name } = await seedSource();

    const response = await fork(name, {
      forkRequestId: crypto.randomUUID(),
      title: "Parser, take two",
    });

    expect(response.status).toBe(201);
    const { sessionId } = await response.json<ForkSessionResponse>();
    expect(await store.get(sessionId)).toMatchObject({ title: "Parser, take two" });
    const forkStub = env.SESSION.get(env.SESSION.idFromName(sessionId));
    const [message] = await queryDO<{ content: string }>(forkStub, "SELECT content FROM messages");
    expect(message.content).toContain('# Handoff from "Fix the parser"');
    expect(message.content).toContain(FORK_CONSENT_LINE);
    await waitForSandboxStatus(forkStub, "failed");
  });

  it("retries a fork that failed before its runtime claimed it", async () => {
    const { name } = await seedSource();
    const forkRequestId = crypto.randomUUID();
    const now = Date.now();
    await store.create({
      id: "failed-fork",
      title: "Fix the parser (fork)",
      repoOwner: null,
      repoName: null,
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "failed",
      ownerTeamId: null,
      visibility: "private",
      userId: MEMBER,
      createdAt: now,
      updatedAt: now,
      fork: { sourceSessionId: name, forkRequestId },
    });

    const response = await fork(name, { forkRequestId, handoff: "Continue." });

    expect(response.status).toBe(201);
    const { sessionId } = await response.json<ForkSessionResponse>();
    expect(sessionId).not.toBe("failed-fork");
    expect(
      await env.DB.prepare(
        "SELECT id, fork_request_id FROM sessions WHERE forked_from_session_id = ? ORDER BY id = 'failed-fork' DESC"
      )
        .bind(name)
        .all()
    ).toMatchObject({
      results: [
        { id: "failed-fork", fork_request_id: null },
        { id: sessionId, fork_request_id: forkRequestId },
      ],
    });
    await waitForSandboxStatus(env.SESSION.get(env.SESSION.idFromName(sessionId)), "failed");
  });

  it("records a bot's fork as that bot's unattended run", async () => {
    const { name } = await seedSource();
    // A web request seeds the member's user row; the Slack identity links to it.
    await serviceFetch(`${BASE}/sessions/${name}/fork/handoff`, {
      as: { userId: MEMBER, role: "member" },
    });
    await insertIdentity({
      id: "fork-slack-member",
      userId: MEMBER,
      provider: "slack",
      providerUserId: "U_FORK_MEMBER",
    });
    const body = JSON.stringify({ forkRequestId: crypto.randomUUID(), handoff: "Continue." });

    const response = await serviceFetch(`${BASE}/sessions/${name}/fork`, {
      method: "POST",
      body,
      service: "slack-bot",
      actor: "slack:U_FORK_MEMBER",
    });

    expect(response.status).toBe(201);
    const { sessionId } = await response.json<ForkSessionResponse>();
    expect(
      await env.DB.prepare("SELECT user_id, spawn_source FROM sessions WHERE id = ?")
        .bind(sessionId)
        .first()
    ).toEqual({ user_id: MEMBER, spawn_source: "slack-bot" });
    await waitForSandboxStatus(env.SESSION.get(env.SESSION.idFromName(sessionId)), "failed");
  });

  it("refuses another person's fork request id without revealing the fork", async () => {
    const { name } = await seedSource();
    const forkRequestId = crypto.randomUUID();
    const first = await fork(name, { forkRequestId, handoff: "Continue." });
    expect(first.status).toBe(201);
    const { sessionId } = await first.json<ForkSessionResponse>();

    const response = await fork(name, { forkRequestId, handoff: "Continue." }, OTHER_MEMBER);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Conflict",
      code: "fork_request_conflict",
    });
    await waitForSandboxStatus(env.SESSION.get(env.SESSION.idFromName(sessionId)), "failed");
  });

  it.each<[Record<string, string>, string]>([
    [{ handoff: "Continue." }, "missing forkRequestId"],
    [{ forkRequestId: crypto.randomUUID(), carry: "handoff" }, "unknown key"],
    [{ forkRequestId: "short", handoff: "Continue." }, "malformed forkRequestId"],
    [{ forkRequestId: crypto.randomUUID(), handoff: "   " }, "blank handoff"],
  ])("rejects a malformed body (%j: %s) before creating anything", async (body) => {
    const { name } = await seedSource();

    const response = await fork(name, body);

    expect(response.status).toBe(400);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM sessions WHERE forked_from_session_id = ?"
      )
        .bind(name)
        .first()
    ).toEqual({ count: 0 });
  });

  it("rejects an unknown model", async () => {
    const { name } = await seedSource();

    const response = await fork(name, {
      forkRequestId: crypto.randomUUID(),
      model: "acme/not-a-model",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('Invalid model "acme/not-a-model"'),
    });
  });
});
