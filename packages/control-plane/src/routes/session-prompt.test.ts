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

describe("POST /sessions/:id/prompt on an auth-home session", () => {
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
    principal: SessionRouteContext["principal"] = { kind: "user", userId }
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
          return Response.json({ messageId: "message-1", status: "queued" });
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

  it("serves a colleague's prompt from the owner's shared home under household and audits it", async () => {
    const response = await prompt(HOUSEHOLD.colleague);
    expect(response.status).toBe(200);
    expect(forwarded).toBe(1);
    expect(await fixture.auditRows("credential.auth_home_prompt")).toEqual([
      {
        actor: HOUSEHOLD.colleague,
        metadata: expect.objectContaining({
          home_owner: HOUSEHOLD.owner,
          actor: HOUSEHOLD.colleague,
          trigger_kind: "prompt",
        }),
      },
    ]);
  });

  it("refuses the colleague under owner_only with no_eligible_home and writes no prompt audit", async () => {
    await fixture.setPolicy("owner_only");
    const response = await prompt(HOUSEHOLD.colleague);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "no_eligible_home" });
    expect(forwarded).toBe(0);
    expect(await fixture.auditRows("credential.auth_home_prompt")).toEqual([]);

    // The owner's own turn is unaffected by the policy.
    expect((await prompt(HOUSEHOLD.owner)).status).toBe(200);
  });

  it("refuses an unenrolled user under both policies", async () => {
    expect((await prompt(HOUSEHOLD.unenrolled)).status).toBe(403);
    await fixture.setPolicy("owner_only");
    const refused = await prompt(HOUSEHOLD.unenrolled);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "no_eligible_home" });
    expect(forwarded).toBe(0);
  });

  it("gates a bot's turn on the kind it names, which only a bot may name", async () => {
    await fixture.db
      .prepare("UPDATE user_auth_homes SET kinds_enabled = ? WHERE id = ?")
      .bind(JSON.stringify(["prompt", "mention"]), HOUSEHOLD.homeId)
      .run();
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

    const labelled = await prompt(HOUSEHOLD.owner, { triggerKind: "issue_label" }, bot);
    expect(labelled.status).toBe(403);
    expect(await labelled.json()).toMatchObject({ reason: "kind_disabled" });
    expect((await prompt(HOUSEHOLD.owner, { triggerKind: "mention" }, bot)).status).toBe(200);
    expect(await fixture.auditRows("credential.auth_home_prompt")).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ trigger_kind: "mention" }) }),
    ]);

    expect((await prompt(HOUSEHOLD.owner, { triggerKind: "schedule" }, bot)).status).toBe(400);
    expect((await prompt(HOUSEHOLD.owner, { triggerKind: "mention" })).status).toBe(400);
    expect(forwarded).toBe(1);
  });

  it("refuses switching the turn to a provider the session's home does not carry", async () => {
    const response = await prompt(HOUSEHOLD.owner, { model: "openai/gpt-5.5" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "no_eligible_home",
      message: expect.stringContaining("no eligible subscription home for openai"),
    });
    expect(forwarded).toBe(0);
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
