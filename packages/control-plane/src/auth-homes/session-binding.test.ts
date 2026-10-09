import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase } from "../node/sqlite-database";
import { HOUSEHOLD, seedHousehold, type HouseholdFixture } from "./auth-homes.test-support";
import { admitAuthHomeTurn, type AuthHomeTurnInput } from "./session-binding";

describe("admitAuthHomeTurn", () => {
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

  function turn(overrides: Partial<AuthHomeTurnInput>) {
    return admitAuthHomeTurn({
      db: fixture.db,
      requestId: "req-1",
      sessionId: HOUSEHOLD.sessionId,
      actorUserId: HOUSEHOLD.colleague,
      triggerKind: "prompt",
      channel: "ws_prompt",
      ...overrides,
    });
  }

  it("re-checks each socket prompt, so a policy flip reaches a socket minted before it", async () => {
    // Minted and first used under household on the owner's shared home.
    await expect(turn({})).resolves.toBeNull();
    expect(await fixture.auditRows("credential.auth_home_prompt")).toEqual([
      {
        actor: HOUSEHOLD.colleague,
        metadata: expect.objectContaining({
          home_owner: HOUSEHOLD.owner,
          channel: "ws_prompt",
          selection: "shared",
        }),
      },
    ]);

    await fixture.setPolicy("owner_only");
    await expect(turn({})).resolves.toEqual({
      reason: "no_eligible_home",
      provider: "anthropic",
      message: expect.any(String),
    });
    expect(await fixture.auditRows("credential.auth_home_prompt")).toHaveLength(1);
    await expect(turn({ actorUserId: HOUSEHOLD.owner })).resolves.toBeNull();
  });

  it("refuses a socket prompt that switches to a provider the home does not carry", async () => {
    await expect(turn({ actorUserId: HOUSEHOLD.owner, model: "openai/gpt-5.5" })).resolves.toEqual(
      expect.objectContaining({ reason: "no_eligible_home", provider: "openai" })
    );
  });
});
