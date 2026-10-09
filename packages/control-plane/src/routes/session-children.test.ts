import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedRoutesModule from "./shared";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { UserAuthHomeStore } from "../auth-homes/store";
import { createTestEnv, fakeSessionRuntimeDispatch } from "../router.test-support";
import { handleSpawnChild } from "./session-child-spawn";
import { SessionIndexStore } from "../db/session-index";
import { resolveSandboxSettings } from "../session/integration-settings-resolution";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { ActivePromptAuthor } from "../session/active-prompt-author";
import type { Env } from "../types";
import { handleCancelChild, handleListChildren, handlePromptChild } from "./session-children";
import type { SessionRouteContext } from "./session-route";
import { routePathPattern } from "../router.test-support";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";

vi.mock("../session/integration-settings-resolution", () => ({
  resolveSandboxSettings: vi.fn(),
  resolveCodeServerEnabled: vi.fn(async () => false),
  resolveVncEnabled: vi.fn(async () => false),
}));

const sourceControl = vi.hoisted(() => ({ isPrivate: true }));
vi.mock("./shared", async (importOriginal) => ({
  ...(await importOriginal<typeof SharedRoutesModule>()),
  createRouteSourceControlProvider: () => ({
    checkRepositoryAccess: async ({ owner, name }: { owner: string; name: string }) => ({
      repoId: 1,
      repoOwner: owner,
      repoName: name,
      defaultBranch: "main",
      isPrivate: sourceControl.isPrivate,
    }),
  }),
}));

function routeMatch(path: string, pattern: string): { id: string; childId: string } {
  const match = path.match(routePathPattern(pattern));
  if (!match?.groups?.id || !match.groups.childId) throw new Error("Expected route match");
  return { id: match.groups.id, childId: match.groups.childId };
}

const defaultPromptAuthor: ActivePromptAuthor = {
  userId: "user-1",
  canonicalUserId: "canonical-1",
  scmUserId: null,
  scmLogin: null,
  scmName: null,
  scmEmail: null,
};

function routeContext(
  fetch: SessionRuntimeClient["fetch"],
  promptAuthor = defaultPromptAuthor
): SessionRouteContext {
  return {
    db: {} as SessionRouteContext["db"],
    metrics: {} as SessionRouteContext["metrics"],
    request_id: "request-id",
    trace_id: "trace-id",
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    sessionRuntime: {
      fetch: async (sessionId, path, init, search) => {
        if (sessionId === "parent" && path === "/internal/active-prompt-author") {
          return Response.json(promptAuthor);
        }
        return fetch(sessionId, path, init, search);
      },
    },
  };
}

function sandboxRouteContext(
  fetch: SessionRuntimeClient["fetch"],
  promptAuthor?: ActivePromptAuthor
): SessionRouteContext {
  return {
    ...routeContext(fetch, promptAuthor),
    principal: { kind: "sandbox", sessionId: "parent" },
  };
}

describe("handleListChildren", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the internal read scope for a parent-bound sandbox", async () => {
    const listByParent = vi
      .spyOn(SessionIndexStore.prototype, "listByParent")
      .mockResolvedValue([]);
    const ctx = routeContext(vi.fn());
    ctx.principal = { kind: "sandbox", sessionId: "parent" };
    ctx.teamsEnforcementMode = "on";
    const response = await handleListChildren(
      new Request("https://test.local/sessions/parent/children"),
      {} as Env,
      { id: "parent" },
      ctx
    );
    expect(response.status).toBe(200);
    expect(listByParent).toHaveBeenCalledWith(
      "parent",
      { kind: "internal", reason: "parent-bound sandbox" },
      "on"
    );
  });

  it("passes the admitted parent viewer and enforcement mode to child selection", async () => {
    const listByParent = vi
      .spyOn(SessionIndexStore.prototype, "listByParent")
      .mockResolvedValue([]);
    const ctx = routeContext(vi.fn());
    const viewer = {
      kind: "user" as const,
      userId: "viewer",
      roleKey: "member" as const,
      permissions: ["sessions.read"] as const,
      suspended: false,
      memberships: new Map([["team-a", "member" as const]]),
    };
    ctx.sessionAdmission = { row: {} as never, viewer };
    ctx.teamsEnforcementMode = "on";

    await handleListChildren(
      new Request("https://test.local/sessions/parent/children"),
      {} as Env,
      { id: "parent" },
      ctx
    );
    expect(listByParent).toHaveBeenCalledWith("parent", viewer, "on");
  });

  it("derives the viewer on the off-mode admission fast path", async () => {
    const listByParent = vi
      .spyOn(SessionIndexStore.prototype, "listByParent")
      .mockResolvedValue([]);
    const ctx = routeContext(vi.fn());
    ctx.teamsEnforcementMode = "off";
    ctx.authorization = {
      userId: "viewer",
      role: { id: "member", key: "member", name: "Member" },
      permissions: ["sessions.read"],
      suspendedAt: null,
    };

    await handleListChildren(
      new Request("https://test.local/sessions/parent/children"),
      {} as Env,
      { id: "parent" },
      ctx
    );
    expect(listByParent).toHaveBeenCalledWith(
      "parent",
      {
        kind: "user",
        userId: "viewer",
        roleKey: "member",
        permissions: ["sessions.read"],
        suspended: false,
        memberships: new Map(),
      },
      "off"
    );
  });

  it("projects viewer-neutral child summaries through the shared schema", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue({
      id: "parent",
      ownerTeamId: null,
      visibility: "workspace",
    } as never);
    vi.spyOn(SessionIndexStore.prototype, "listByParent").mockResolvedValue([
      {
        id: "child",
        title: "Child",
        repoOwner: "acme",
        repoName: "web",
        harness: "opencode",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: "main",
        status: "active",
        ownerTeamId: null,
        visibility: "workspace",
        parentSessionId: "parent",
        spawnSource: "agent",
        spawnDepth: 1,
        automationId: null,
        automationRunId: null,
        scmLogin: null,
        userId: "user-1",
        totalCost: 0,
        activeDurationMs: 0,
        messageCount: 1,
        prCount: 0,
        environmentId: null,
        createdAt: 100,
        updatedAt: 200,
        readState: { latestMessageId: "message-1", unread: true, version: 200 },
      },
    ]);

    const response = await handleListChildren(
      new Request("https://test.local/sessions/parent/children"),
      {} as Env,
      { id: "parent" },
      Object.assign(routeContext(vi.fn()), {
        principal: { kind: "sandbox", sessionId: "parent" },
        teamsEnforcementMode: "on",
      })
    );
    await expect(response.json()).resolves.toEqual({
      children: [
        {
          id: "child",
          ownerTeamId: null,
          visibility: "workspace",
          title: "Child",
          repoOwner: "acme",
          repoName: "web",
          harness: "opencode",
          model: "anthropic/claude-sonnet-4-6",
          reasoningEffort: null,
          baseBranch: "main",
          status: "active",
          parentSessionId: "parent",
          spawnSource: "agent",
          spawnDepth: 1,
          automationId: null,
          automationRunId: null,
          scmLogin: null,
          userId: "user-1",
          totalCost: 0,
          activeDurationMs: 0,
          messageCount: 1,
          prCount: 0,
          environmentId: null,
          createdAt: 100,
          updatedAt: 200,
        },
      ],
    });
  });
});

describe("handlePromptChild", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(resolveSandboxSettings).mockReset();
  });

  it("reserves terminal-child capacity from parent policy for child-owned finalization", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get")
      .mockResolvedValueOnce({
        id: "child",
        parentSessionId: "parent",
        status: "completed",
        ownerTeamId: null,
        visibility: "workspace",
      } as never)
      .mockResolvedValueOnce({
        id: "parent",
        repoOwner: "acme",
        repoName: "repo",
        environmentId: "env-1",
        ownerTeamId: null,
      } as never);
    vi.mocked(resolveSandboxSettings).mockResolvedValue({ maxConcurrentChildSessions: 2 });
    const lease = { token: "lease-1", childSessionId: "child", expiresAt: Date.now() + 60_000 };
    const reserve = vi
      .spyOn(SessionIndexStore.prototype, "acquireChildAdmissionLease")
      .mockResolvedValue(lease);
    const release = vi
      .spyOn(SessionIndexStore.prototype, "releaseChildAdmissionLease")
      .mockResolvedValue();
    vi.spyOn(SessionIndexStore.prototype, "touchUpdatedAt").mockResolvedValue(true);
    const childResponse = Response.json({ messageId: "message-1", status: "queued" });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => childResponse);

    const response = await handlePromptChild(
      new Request("https://test.local/sessions/parent/children/child/prompt", {
        method: "POST",
        body: JSON.stringify({ content: "Continue" }),
      }),
      {} as Env,
      routeMatch(
        "/sessions/parent/children/child/prompt",
        "/sessions/:id/children/:childId/prompt"
      ),
      sandboxRouteContext(fetch)
    );

    expect(response.status).toBe(200);
    expect(resolveSandboxSettings).toHaveBeenCalledWith(expect.anything(), "acme", "repo", "env-1");
    expect(reserve).toHaveBeenCalledWith("parent", "child", 2);
    expect(release).not.toHaveBeenCalled();
    expect(response).toBe(childResponse);
  });

  it("does not resolve policy or reserve capacity for an active child", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get")
      .mockResolvedValueOnce({
        id: "child",
        parentSessionId: "parent",
        status: "active",
        ownerTeamId: null,
        visibility: "workspace",
      } as never)
      .mockResolvedValueOnce({ id: "parent", ownerTeamId: null } as never);
    const reserve = vi.spyOn(SessionIndexStore.prototype, "acquireChildAdmissionLease");
    const childResponse = Response.json({ messageId: "message-1", status: "queued" });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => childResponse);

    const response = await handlePromptChild(
      new Request("https://test.local/sessions/parent/children/child/prompt", {
        method: "POST",
        body: JSON.stringify({ content: "Continue" }),
      }),
      {} as Env,
      routeMatch(
        "/sessions/parent/children/child/prompt",
        "/sessions/:id/children/:childId/prompt"
      ),
      sandboxRouteContext(fetch)
    );

    expect(response).toBe(childResponse);
    expect(resolveSandboxSettings).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("accepts the child response when the best-effort message id payload is malformed", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get")
      .mockResolvedValueOnce({
        id: "child",
        parentSessionId: "parent",
        status: "active",
        ownerTeamId: null,
        visibility: "workspace",
      } as never)
      .mockResolvedValueOnce({ id: "parent", ownerTeamId: null } as never);
    vi.spyOn(SessionIndexStore.prototype, "touchUpdatedAt").mockResolvedValue(true);
    const childResponse = new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => childResponse);

    const response = await handlePromptChild(
      new Request("https://test.local/sessions/parent/children/child/prompt", {
        method: "POST",
        body: JSON.stringify({ content: "Continue" }),
      }),
      {} as Env,
      routeMatch(
        "/sessions/parent/children/child/prompt",
        "/sessions/:id/children/:childId/prompt"
      ),
      sandboxRouteContext(fetch)
    );

    expect(response).toBe(childResponse);
    expect(response.status).toBe(200);
  });

  it("forwards the parent active prompt author to the child", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get")
      .mockResolvedValueOnce({
        id: "child",
        parentSessionId: "parent",
        status: "active",
        ownerTeamId: null,
        visibility: "workspace",
      } as never)
      .mockResolvedValueOnce({ id: "parent", ownerTeamId: null } as never);
    const promptAuthor = {
      userId: "slack:U2",
      canonicalUserId: "canonical-2",
      scmUserId: "222",
      scmLogin: "second-user",
      scmName: "Second User",
      scmEmail: "second@example.com",
    };
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async (sessionId, path, init) => {
      expect(sessionId).toBe("child");
      expect(path).toBe("/internal/parent-prompt");
      const forwarded = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(forwarded).toMatchObject({
        author: {
          userId: "slack:U2",
          canonicalUserId: "canonical-2",
          scmLogin: "second-user",
        },
      });
      expect(forwarded.author).not.toHaveProperty("scmAccessTokenEncrypted");
      return Response.json({ messageId: "message-1", status: "queued" });
    });

    const response = await handlePromptChild(
      new Request("https://test.local/sessions/parent/children/child/prompt", {
        method: "POST",
        body: JSON.stringify({ content: "Continue" }),
      }),
      {} as Env,
      routeMatch(
        "/sessions/parent/children/child/prompt",
        "/sessions/:id/children/:childId/prompt"
      ),
      sandboxRouteContext(fetch, promptAuthor)
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a terminal-child resume when the parent has no capacity", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get")
      .mockResolvedValueOnce({
        id: "child",
        parentSessionId: "parent",
        status: "failed",
        ownerTeamId: null,
        visibility: "workspace",
      } as never)
      .mockResolvedValueOnce({ id: "parent", ownerTeamId: null } as never);
    vi.mocked(resolveSandboxSettings).mockResolvedValue({ maxConcurrentChildSessions: 1 });
    vi.spyOn(SessionIndexStore.prototype, "acquireChildAdmissionLease").mockResolvedValue(null);
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>();

    const response = await handlePromptChild(
      new Request("https://test.local/sessions/parent/children/child/prompt", {
        method: "POST",
        body: JSON.stringify({ content: "Continue" }),
      }),
      {} as Env,
      routeMatch(
        "/sessions/parent/children/child/prompt",
        "/sessions/:id/children/:childId/prompt"
      ),
      sandboxRouteContext(fetch)
    );

    expect(response.status).toBe(429);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("releases terminal-child capacity after a definitive child rejection", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get")
      .mockResolvedValueOnce({
        id: "child",
        parentSessionId: "parent",
        status: "completed",
        ownerTeamId: null,
        visibility: "workspace",
      } as never)
      .mockResolvedValueOnce({ id: "parent", ownerTeamId: null } as never);
    vi.mocked(resolveSandboxSettings).mockResolvedValue({ maxConcurrentChildSessions: 2 });
    const lease = { token: "lease-1", childSessionId: "child", expiresAt: Date.now() + 60_000 };
    vi.spyOn(SessionIndexStore.prototype, "acquireChildAdmissionLease").mockResolvedValue(lease);
    const release = vi
      .spyOn(SessionIndexStore.prototype, "releaseChildAdmissionLease")
      .mockResolvedValue();
    const childResponse = Response.json({ error: "Cannot prompt child" }, { status: 409 });
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => childResponse);

    const response = await handlePromptChild(
      new Request("https://test.local/sessions/parent/children/child/prompt", {
        method: "POST",
        body: JSON.stringify({ content: "Continue" }),
      }),
      {} as Env,
      routeMatch(
        "/sessions/parent/children/child/prompt",
        "/sessions/:id/children/:childId/prompt"
      ),
      sandboxRouteContext(fetch)
    );

    expect(response).toBe(childResponse);
    expect(release).toHaveBeenCalledWith(lease);
  });

  it("retains terminal-child capacity when dispatch has an ambiguous transport failure", async () => {
    vi.spyOn(SessionIndexStore.prototype, "get")
      .mockResolvedValueOnce({
        id: "child",
        parentSessionId: "parent",
        status: "completed",
        ownerTeamId: null,
        visibility: "workspace",
      } as never)
      .mockResolvedValueOnce({ id: "parent", ownerTeamId: null } as never);
    vi.mocked(resolveSandboxSettings).mockResolvedValue({ maxConcurrentChildSessions: 2 });
    const lease = { token: "lease-1", childSessionId: "child", expiresAt: Date.now() + 60_000 };
    vi.spyOn(SessionIndexStore.prototype, "acquireChildAdmissionLease").mockResolvedValue(lease);
    const release = vi
      .spyOn(SessionIndexStore.prototype, "releaseChildAdmissionLease")
      .mockResolvedValue();
    const fetchError = new Error("response lost");
    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async () => {
      throw fetchError;
    });

    await expect(
      handlePromptChild(
        new Request("https://test.local/sessions/parent/children/child/prompt", {
          method: "POST",
          body: JSON.stringify({ content: "Continue" }),
        }),
        {} as Env,
        routeMatch(
          "/sessions/parent/children/child/prompt",
          "/sessions/:id/children/:childId/prompt"
        ),
        sandboxRouteContext(fetch)
      )
    ).rejects.toBe(fetchError);

    expect(release).not.toHaveBeenCalled();
  });
});
describe("handleCancelChild", () => {
  afterEach(() => vi.restoreAllMocks());

  it("attempts every descendant and aggregates non-conflict failures", async () => {
    vi.spyOn(SessionIndexStore.prototype, "isChildOf").mockResolvedValue(true);
    vi.spyOn(SessionIndexStore.prototype, "get").mockImplementation(
      async (id) => ({ id, ownerTeamId: null, visibility: "workspace" }) as never
    );
    vi.spyOn(SessionIndexStore.prototype, "listActiveDescendantIds").mockResolvedValue([
      "deep-failure",
      "later-success",
      "shallow-failure",
    ]);

    const fetch = vi.fn<SessionRuntimeClient["fetch"]>(async (sessionId) => {
      if (sessionId === "child") return Response.json({ status: "cancelled" });
      if (sessionId === "deep-failure" || sessionId === "shallow-failure") {
        return Response.json({ error: "failure" }, { status: 500 });
      }
      return Response.json({ status: "cancelled" });
    });
    const match = routeMatch(
      "/sessions/parent/children/child/cancel",
      "/sessions/:id/children/:childId/cancel"
    );

    const ctx = routeContext(fetch);
    ctx.principal = { kind: "sandbox", sessionId: "parent" };
    const response = await handleCancelChild(
      new Request("https://test.local/sessions/parent/children/child/cancel", { method: "POST" }),
      {} as Env,
      match,
      ctx
    );

    expect(fetch.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      "child",
      "deep-failure",
      "later-success",
      "shallow-failure",
    ]);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Nested tasks could not be cancelled: deep-failure, shallow-failure",
      cancelledDescendantIds: ["later-success"],
    });
  });
});

describe("handleSpawnChild with auth homes", () => {
  const OWNER = "user-owner";
  let db: NodeSqlDatabase;
  let initialized: string[];

  beforeEach(async () => {
    vi.mocked(resolveSandboxSettings).mockResolvedValue({});
    sourceControl.isPrivate = true;
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    db = createNodeSqlDatabase(sqlite);
    await db
      .prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, 1, 1)")
      .bind(OWNER, OWNER)
      .run();
    await new UserAuthHomeStore(db).register({
      id: "H1",
      ownerUserIds: [OWNER],
      pvcName: "sf-home-owner",
      nodeName: "sandbox-node-1",
      providers: ["anthropic", "openai"],
      backgroundConsentAt: 1,
    });
    initialized = [];
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  async function insertParent(model: string, repo: { owner: string; name: string } | null) {
    await db
      .prepare(
        `INSERT INTO sessions (id, title, repo_owner, repo_name, model, status, user_id, created_at,
           updated_at, trigger_actor_user_id, trigger_kind, auth_home_id, auth_home_selection)
         VALUES ('parent', 'Parent', ?, ?, ?, 'active', ?, 1, 1, ?, 'prompt', 'H1', 'own')`
      )
      .bind(repo?.owner ?? null, repo?.name ?? null, model, OWNER, OWNER)
      .run();
  }

  function spawn(model: string, repo: { owner: string; name: string } | null) {
    const runtime: SessionRuntimeClient["fetch"] = async (sessionId, path) => {
      if (path === "/internal/spawn-context") {
        return Response.json({
          repoOwner: repo?.owner ?? null,
          repoName: repo?.name ?? null,
          repoId: repo ? 1 : null,
          harness: "opencode",
          model,
          reasoningEffort: null,
          baseBranch: repo ? "main" : null,
          promptAuthor: { ...defaultPromptAuthor, canonicalUserId: OWNER },
        });
      }
      return Response.json({ messageId: `m-${sessionId}` });
    };
    const ctx: SessionRouteContext = {
      db,
      metrics: {} as SessionRouteContext["metrics"],
      request_id: "request-spawn",
      trace_id: "trace-spawn",
      executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
      principal: { kind: "sandbox", sessionId: "parent" },
      sessionRuntime: { fetch: runtime },
    };
    const env = createTestEnv({
      DB: db,
      SESSION: fakeSessionRuntimeDispatch(async (_request, sessionId) => {
        initialized.push(sessionId);
        return Response.json({ status: "created" });
      }),
    });
    return handleSpawnChild(
      new Request("https://test.local/sessions/parent/children", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Child", prompt: "Do the thing" }),
      }),
      env,
      { id: "parent" },
      ctx
    );
  }

  it("inherits the parent's trigger actor and resolves to the same home as a child", async () => {
    await insertParent("anthropic/claude-sonnet-4-6", null);
    const response = await spawn("anthropic/claude-sonnet-4-6", null);
    expect(response.status).toBe(201);
    const { sessionId } = (await response.json()) as { sessionId: string };

    const row = await db
      .prepare(
        `SELECT trigger_actor_user_id, trigger_kind, auth_home_id, auth_home_selection
         FROM sessions WHERE id = ?`
      )
      .bind(sessionId)
      .first();
    expect(row).toEqual({
      trigger_actor_user_id: OWNER,
      trigger_kind: "child",
      auth_home_id: "H1",
      auth_home_selection: "own",
    });
    const auth = await db
      .prepare(
        `SELECT auth_mode, selection_source FROM session_model_provider_auth
         WHERE session_id = ? AND provider = 'anthropic'`
      )
      .bind(sessionId)
      .first();
    expect(auth).toEqual({ auth_mode: "auth_home", selection_source: "auth_home_own" });
    expect(initialized).toEqual([sessionId]);
  });

  it("refuses a Codex child on a public repository with public_repo", async () => {
    sourceControl.isPrivate = false;
    const repo = { owner: "acme", name: "public-site" };
    await insertParent("openai/gpt-5.5", repo);
    const response = await spawn("openai/gpt-5.5", repo);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "public_repo", reason: "public_repo" });
    expect(initialized).toEqual([]);
    const children = await db
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id = 'parent'")
      .first<{ n: number }>();
    expect(children?.n).toBe(0);
  });
});
