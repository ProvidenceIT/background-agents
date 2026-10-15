import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase } from "../node/sqlite-database";
import { HOUSEHOLD, seedHousehold, type HouseholdFixture } from "./auth-homes.test-support";
import {
  AuthHomeTurnRefusedError,
  checkAuthHomeAccess,
  TurnAdmission,
  type HomeTurn,
  type TurnAdmissionDeps,
  type TurnRequest,
} from "./turn-admission";

describe("TurnAdmission", () => {
  let fixture: HouseholdFixture & { close(): void };
  let admitUsage: ReturnType<typeof vi.fn<TurnAdmissionDeps["admitUsage"]>>;
  let enqueued: number;

  beforeEach(async () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    const db = createNodeSqlDatabase(sqlite);
    fixture = { ...(await seedHousehold(db)), close: () => db.close() };
    admitUsage = vi.fn<TurnAdmissionDeps["admitUsage"]>(async () => undefined);
    enqueued = 0;
  });
  afterEach(() => fixture.close());

  const admission = () =>
    new TurnAdmission({
      db: fixture.db,
      getSessionId: () => HOUSEHOLD.sessionId,
      admitUsage,
    });

  function homeTurn(overrides: Partial<HomeTurn> = {}): HomeTurn {
    return {
      actor: { userId: HOUSEHOLD.colleague },
      triggerKind: "prompt",
      model: null,
      channel: "ws_prompt",
      requestId: "req-1",
      ...overrides,
    };
  }

  /** Admit one turn whose enqueue adds a message (or replays one, with `added: false`). */
  function admit(request: TurnRequest, added = true) {
    return admission().admit(request, async () => {
      enqueued += 1;
      return { value: "message-1", added };
    });
  }

  const promptAudits = () => fixture.auditRows("credential.auth_home_prompt");

  it("serves a colleague from the owner's shared home under household, and audits the turn", async () => {
    await expect(admit({ home: homeTurn(), meteredUserId: HOUSEHOLD.colleague })).resolves.toBe(
      "message-1"
    );
    expect(enqueued).toBe(1);
    expect(admitUsage).toHaveBeenCalledWith({
      userId: HOUSEHOLD.colleague,
      sessionId: HOUSEHOLD.sessionId,
      requestId: "req-1",
    });
    expect(await promptAudits()).toEqual([
      {
        actor: HOUSEHOLD.colleague,
        metadata: expect.objectContaining({
          home_owner: HOUSEHOLD.owner,
          actor: HOUSEHOLD.colleague,
          selection: "shared",
          trigger_kind: "prompt",
          channel: "ws_prompt",
        }),
      },
    ]);
  });

  it("re-checks each turn, so a policy flip reaches a socket minted before it", async () => {
    await admit({ home: homeTurn() });
    await fixture.setPolicy("owner_only");

    const refusal = admit({ home: homeTurn(), meteredUserId: HOUSEHOLD.colleague });
    await expect(refusal).rejects.toBeInstanceOf(AuthHomeTurnRefusedError);
    await expect(refusal).rejects.toMatchObject({
      refusal: { reason: "no_eligible_home", provider: "anthropic" },
    });
    expect(enqueued).toBe(1);
    expect(admitUsage).not.toHaveBeenCalled();
    expect(await promptAudits()).toHaveLength(1);

    // The owner's own turn is unaffected by the policy.
    await expect(admit({ home: homeTurn({ actor: { userId: HOUSEHOLD.owner } }) })).resolves.toBe(
      "message-1"
    );
  });

  it("refuses an unenrolled or unlinked actor under both policies", async () => {
    for (const policy of ["household", "owner_only"] as const) {
      await fixture.setPolicy(policy);
      for (const userId of [HOUSEHOLD.unenrolled, null]) {
        await expect(admit({ home: homeTurn({ actor: { userId } }) })).rejects.toMatchObject({
          refusal: { reason: "no_eligible_home" },
        });
      }
    }
    expect(enqueued).toBe(0);
  });

  it("applies the home's trigger-kind gate to every turn", async () => {
    await fixture.db
      .prepare("UPDATE user_auth_homes SET kinds_enabled = ? WHERE id = ?")
      .bind(JSON.stringify(["prompt", "mention"]), HOUSEHOLD.homeId)
      .run();
    const owner = { userId: HOUSEHOLD.owner };
    await expect(
      admit({ home: homeTurn({ actor: owner, triggerKind: "pr_event" }) })
    ).rejects.toMatchObject({ refusal: { reason: "kind_disabled" } });
    await admit({ home: homeTurn({ actor: owner, triggerKind: "mention" }) });
    expect(await promptAudits()).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ trigger_kind: "mention" }) }),
    ]);
  });

  it("refuses switching the turn to a provider the session's home does not carry", async () => {
    await expect(
      admit({ home: homeTurn({ actor: { userId: HOUSEHOLD.owner }, model: "openai/gpt-5.5" }) })
    ).rejects.toMatchObject({
      refusal: {
        reason: "no_eligible_home",
        provider: "openai",
        message: expect.stringContaining("no eligible subscription home for openai"),
      },
    });
  });

  it("charges the session's owner for a turn taken on their behalf", async () => {
    await fixture.setPolicy("owner_only");
    await admit({ home: homeTurn({ actor: "session_owner", channel: "autofix" }) });
    expect(await promptAudits()).toEqual([
      {
        actor: HOUSEHOLD.owner,
        metadata: expect.objectContaining({ selection: "own", channel: "autofix" }),
      },
    ]);
  });

  it("records only a turn the enqueue actually added", async () => {
    await admit({ home: homeTurn() }, false);
    expect(enqueued).toBe(1);
    expect(await promptAudits()).toEqual([]);
  });

  it("writes nothing for a turn the usage quota refuses", async () => {
    admitUsage.mockRejectedValue(new Error("quota"));
    await expect(admit({ home: homeTurn(), meteredUserId: HOUSEHOLD.colleague })).rejects.toThrow(
      "quota"
    );
    expect(enqueued).toBe(0);
    expect(await promptAudits()).toEqual([]);
  });

  it("does not check the home again for a first turn its session's creation admitted", async () => {
    await fixture.setPolicy("owner_only");
    await admit({ home: "admitted_at_create", meteredUserId: HOUSEHOLD.colleague });
    expect(enqueued).toBe(1);
    expect(admitUsage).toHaveBeenCalledOnce();
    expect(await promptAudits()).toEqual([]);
  });

  it("does not gate a session that is bound to no home", async () => {
    await fixture.db.prepare("UPDATE sessions SET auth_home_id = NULL").run();
    await admit({ home: homeTurn({ actor: { userId: HOUSEHOLD.unenrolled } }) });
    expect(enqueued).toBe(1);
    expect(await promptAudits()).toEqual([]);
  });
});

describe("checkAuthHomeAccess", () => {
  let fixture: HouseholdFixture & { close(): void };

  beforeEach(async () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    const db = createNodeSqlDatabase(sqlite);
    fixture = { ...(await seedHousehold(db)), close: () => db.close() };
  });
  afterEach(() => fixture.close());

  const access = (actorUserId: string | null) =>
    checkAuthHomeAccess({
      db: fixture.db,
      sessionId: HOUSEHOLD.sessionId,
      actorUserId,
      triggerKind: "prompt",
    });

  it("lets an eligible actor reach the home and refuses anyone else, recording no turn", async () => {
    await expect(access(HOUSEHOLD.colleague)).resolves.toBeNull();
    await fixture.setPolicy("owner_only");
    const refused = await access(HOUSEHOLD.colleague);
    expect(refused?.status).toBe(403);
    await expect(refused?.json()).resolves.toMatchObject({ code: "no_eligible_home" });
    await expect(access(HOUSEHOLD.owner)).resolves.toBeNull();
    expect(await fixture.auditRows("credential.auth_home_prompt")).toEqual([]);
  });
});
