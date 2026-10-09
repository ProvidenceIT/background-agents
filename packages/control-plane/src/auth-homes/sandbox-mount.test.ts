import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { AuthHomeUnavailableError } from "../sandbox/provider";
import { createSessionAuthHomeLookup, type SessionAuthHomeLookup } from "./sandbox-mount";
import { UserAuthHomeStore } from "./store";

describe("createSessionAuthHomeLookup", () => {
  let db: NodeSqlDatabase;
  let homes: UserAuthHomeStore;
  let lookup: SessionAuthHomeLookup;

  beforeEach(async () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    db = createNodeSqlDatabase(sqlite);
    homes = new UserAuthHomeStore(db);
    lookup = createSessionAuthHomeLookup(db);
    await homes.register({
      id: "ah_bram",
      ownerUserIds: ["u1", "u1-alt"],
      pvcName: "sf-home-bram",
      nodeName: "agent.dokman.io",
      providers: ["anthropic", "openai"],
    });
  });
  afterEach(() => db.close());

  async function session(id: string, authHomeId: string | null) {
    await db
      .prepare(
        "INSERT INTO sessions (id, user_id, auth_home_id, created_at, updated_at) VALUES (?, 'u2', ?, 1, 1)"
      )
      .bind(id, authHomeId)
      .run();
  }

  it("names the bound home's claim, its owner and its providers", async () => {
    await session("s1", "ah_bram");
    await expect(lookup.getForSession("s1")).resolves.toEqual({
      pvcName: "sf-home-bram",
      ownerUserId: "u1",
      providers: ["anthropic", "openai"],
    });
  });

  it("finds nothing for a session without a binding or without a row", async () => {
    await session("s1", null);
    await expect(lookup.getForSession("s1")).resolves.toBeUndefined();
    await expect(lookup.getForSession("unknown")).resolves.toBeUndefined();
  });

  it("refuses a binding to a disabled home", async () => {
    await session("s1", "ah_bram");
    await homes.update("ah_bram", { status: "disabled" });
    const error = await lookup.getForSession("s1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthHomeUnavailableError);
    expect((error as Error).message).toBe("Subscription home ah_bram is disabled");
  });

  it("refuses a binding to a home that was removed", async () => {
    await session("s1", "ah_bram");
    await homes.remove("ah_bram");
    await expect(lookup.getForSession("s1")).rejects.toThrow(
      "Subscription home ah_bram is no longer registered"
    );
  });
});
