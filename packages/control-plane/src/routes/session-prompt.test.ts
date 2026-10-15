import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase } from "../node/sqlite-database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CredentialAuthorityModule from "../source-control/github-credential-authority";
import type * as IdentityModule from "../session/identity";
import { HOUSEHOLD, seedHousehold } from "../auth-homes/auth-homes.test-support";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";
import type { Env } from "../types";
import { handleSessionPrompt } from "./session-prompt";
import type { SessionRouteContext } from "./session-route";

// SCM enrichment is out of scope here: no linked GitHub account.

async function createHouseholdFixture() {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(
    sqlite,
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
  );
  const db = createNodeSqlDatabase(sqlite);
  return { ...(await seedHousehold(db)), close: () => db.close() };
}

vi.mock("../source-control/github-credential-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof CredentialAuthorityModule>()),
  resolveGitHubCredentialAuthority: vi.fn(async () => ({})),
}));
vi.mock("../session/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof IdentityModule>()),
  resolveGitHubEnrichmentForRequest: vi.fn(async () => null),
}));

describe("POST /sessions/:id/prompt", () => {
  let fixture: Awaited<ReturnType<typeof createHouseholdFixture>>;
  let forwarded: number;
  let forwardedBodies: Record<string, unknown>[];

  beforeEach(async () => {
    fixture = await createHouseholdFixture();
    forwarded = 0;
    forwardedBodies = [];
  });
  afterEach(() => fixture.close());

  function prompt(
    userId: string,
    body: Record<string, unknown> = {},
    principal: SessionRouteContext["principal"] = { kind: "user", userId },
    queueResponse?: Response
  ) {
    const ctx: SessionRouteContext = {
      db: fixture.db,
      metrics: {} as SessionRouteContext["metrics"],
      request_id: `req-${userId}`,
      trace_id: "trace-prompt",
      executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
      principal,
      sessionRuntime: {
        fetch: async (_sessionId, _path, init) => {
          forwarded += 1;
          forwardedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return queueResponse ?? Response.json({ messageId: "message-1", status: "queued" });
        },
      },
    };
    return handleSessionPrompt(
      new Request(`https://test.local/sessions/${HOUSEHOLD.sessionId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Next step", ...body }),
      }),
      {} as Env,
      { id: HOUSEHOLD.sessionId },
      ctx
    );
  }

  it("forwards the turn to the session's prompt queue, which admits it on the home", async () => {
    // Under owner_only the colleague may not spend the owner's home, but the
    // route does not decide that: the queue does (ADR 0005).
    await fixture.setPolicy("owner_only");
    const response = await prompt(HOUSEHOLD.colleague);
    expect(response.status).toBe(200);
    expect(forwardedBodies).toEqual([
      expect.objectContaining({
        turn: { triggerKind: "prompt", channel: "prompt", requestId: `req-${HOUSEHOLD.colleague}` },
        canonicalUserId: HOUSEHOLD.colleague,
      }),
    ]);
    expect(await fixture.auditRows("credential.auth_home_prompt")).toEqual([]);
  });

  it("passes the queue's refusal back unchanged", async () => {
    const refusal = Response.json(
      {
        error: "refused",
        message: "refused",
        code: "no_eligible_home",
        reason: "no_eligible_home",
      },
      { status: 403 }
    );
    const response = await prompt(HOUSEHOLD.colleague, {}, undefined, refusal);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "no_eligible_home" });
  });

  it("forwards the trigger kind a bot names, which only a bot may name", async () => {
    const bot: SessionRouteContext["principal"] = {
      kind: "service",
      service: "slack-bot",
      actor: {
        provider: "slack",
        providerUserId: "U1",
        canonicalUserId: HOUSEHOLD.owner,
        participantUserId: "slack:U1",
      },
    };

    expect((await prompt(HOUSEHOLD.owner, { triggerKind: "issue_label" }, bot)).status).toBe(200);
    expect((await prompt(HOUSEHOLD.owner, {}, bot)).status).toBe(200);
    expect(
      forwardedBodies.map((body) => (body.turn as { triggerKind: string }).triggerKind)
    ).toEqual(["issue_label", "mention"]);

    expect((await prompt(HOUSEHOLD.owner, { triggerKind: "schedule" }, bot)).status).toBe(400);
    expect((await prompt(HOUSEHOLD.owner, { triggerKind: "mention" })).status).toBe(400);
    expect(forwarded).toBe(2);
  });

  it("namespaces a service's clientRequestId and refuses one from a person", async () => {
    const motion: SessionRouteContext["principal"] = {
      kind: "service",
      service: "motion",
      actor: {
        provider: "microsoft",
        providerUserId: "oid-owner",
        canonicalUserId: HOUSEHOLD.owner,
        participantUserId: "microsoft:oid-owner",
      },
    };

    expect((await prompt(HOUSEHOLD.owner, { clientRequestId: "wi-1:p1" }, motion)).status).toBe(
      200
    );
    expect(forwardedBodies[0]).toMatchObject({ clientRequestId: "svc:motion:wi-1:p1" });

    const person = await prompt(HOUSEHOLD.owner, { clientRequestId: "wi-1:p1" });
    expect(person.status).toBe(400);
    await expect(person.json()).resolves.toMatchObject({ code: "client_request_id_not_allowed" });
    expect((await prompt(HOUSEHOLD.owner, { clientRequestId: "bad key" }, motion)).status).toBe(
      400
    );
    expect(forwarded).toBe(1);
  });
});
