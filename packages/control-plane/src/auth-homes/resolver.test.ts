import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TriggerKind } from "@open-inspect/shared/types/auth-homes";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { authHomesInForce, checkTurnEligibility, resolveAuthHome } from "./resolver";
import { SubscriptionSharingStore, UserAuthHomeStore } from "./store";

const OWNER = "user-owner";
const COLLEAGUE = "user-colleague";
const UNENROLLED = "user-unenrolled";
const REGISTERED_AT = Date.UTC(2026, 9, 1);

describe("auth-home resolver", () => {
  let db: NodeSqlDatabase;
  let homes: UserAuthHomeStore;

  beforeEach(() => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(
      sqlite,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    db = createNodeSqlDatabase(sqlite);
    homes = new UserAuthHomeStore(db);
  });
  afterEach(() => db.close());

  async function registerHouseholdHomes(options: { ownerShared?: boolean } = {}) {
    const shared = options.ownerShared ?? true;
    const h1 = await homes.register({
      id: "H1",
      ownerUserIds: [OWNER],
      pvcName: "sf-home-owner",
      nodeName: "sandbox-node-1",
      providers: ["anthropic", "zai-coding-plan"],
      shared,
      sharingConsentAt: shared ? REGISTERED_AT : null,
      now: REGISTERED_AT,
    });
    const h2 = await homes.register({
      id: "H2",
      ownerUserIds: [COLLEAGUE],
      pvcName: "sf-home-colleague",
      nodeName: "sandbox-node-1",
      providers: ["zai-coding-plan"],
      now: REGISTERED_AT + 1,
    });
    return { h1, h2 };
  }

  function resolveFor(
    actorUserId: string | null,
    provider: string,
    extra: { triggerKind?: TriggerKind; repoPrivate?: boolean | null } = {}
  ) {
    return resolveAuthHome({
      db,
      actorUserId,
      provider,
      triggerKind: extra.triggerKind ?? "prompt",
      repoPrivate: extra.repoPrivate === undefined ? true : extra.repoPrivate,
    });
  }

  async function insertSession(id: string, homeId: string, status: string) {
    await db
      .prepare(
        `INSERT INTO sessions (id, title, repo_owner, repo_name, model, status, created_at, updated_at, auth_home_id)
         VALUES (?, NULL, NULL, NULL, 'anthropic/claude-sonnet-4-6', ?, 1, 1, ?)`
      )
      .bind(id, status, homeId)
      .run();
  }

  it("is in force only once a home is registered", async () => {
    expect(await authHomesInForce(db)).toBe(false);
    await registerHouseholdHomes();
    expect(await authHomesInForce(db)).toBe(true);
  });

  it("serves own homes first, then a shared home, and refuses the unenrolled under household", async () => {
    await registerHouseholdHomes();

    expect(await resolveFor(OWNER, "anthropic")).toEqual({
      kind: "own",
      homeId: "H1",
      homeOwnerUserId: OWNER,
    });
    expect(await resolveFor(COLLEAGUE, "zai-coding-plan")).toEqual({
      kind: "own",
      homeId: "H2",
      homeOwnerUserId: COLLEAGUE,
    });
    expect(await resolveFor(COLLEAGUE, "anthropic")).toEqual({
      kind: "shared",
      homeId: "H1",
      homeOwnerUserId: OWNER,
    });
    expect(await resolveFor(UNENROLLED, "anthropic")).toEqual({
      kind: "refused",
      reason: "no_eligible_home",
    });
    expect(await resolveFor(null, "anthropic")).toEqual({
      kind: "refused",
      reason: "no_eligible_home",
    });
  });

  it("refuses sharing_off when the only home carrying the provider is not shared", async () => {
    await registerHouseholdHomes({ ownerShared: false });

    expect(await resolveFor(COLLEAGUE, "anthropic")).toEqual({
      kind: "refused",
      reason: "sharing_off",
      homeId: "H1",
      homeOwnerUserId: OWNER,
    });
  });

  it("refuses no_eligible_home for a colleague under owner_only, while owners keep their homes", async () => {
    await registerHouseholdHomes();
    await new SubscriptionSharingStore(db).set("owner_only", OWNER);

    expect(await resolveFor(COLLEAGUE, "anthropic")).toEqual({
      kind: "refused",
      reason: "no_eligible_home",
    });
    expect(await resolveFor(OWNER, "anthropic")).toMatchObject({ kind: "own", homeId: "H1" });
  });

  it("serves OpenAI only for private repositories and with background consent beyond prompts", async () => {
    await registerHouseholdHomes();
    await homes.update("H1", { providers: ["anthropic", "zai-coding-plan", "openai"] });

    expect(await resolveFor(OWNER, "openai", { repoPrivate: false })).toEqual({
      kind: "refused",
      reason: "public_repo",
      homeId: "H1",
      homeOwnerUserId: OWNER,
    });
    expect(await resolveFor(OWNER, "openai", { repoPrivate: null })).toMatchObject({
      kind: "refused",
      reason: "public_repo",
    });
    expect(await resolveFor(OWNER, "openai", { triggerKind: "schedule" })).toEqual({
      kind: "refused",
      reason: "no_consent",
      homeId: "H1",
      homeOwnerUserId: OWNER,
    });
    expect(await resolveFor(OWNER, "openai")).toMatchObject({ kind: "own", homeId: "H1" });

    await homes.update("H1", { backgroundConsentAt: REGISTERED_AT });
    expect(await resolveFor(OWNER, "openai", { triggerKind: "schedule" })).toMatchObject({
      kind: "own",
    });
    expect(
      await resolveAuthHome({
        db,
        actorUserId: OWNER,
        provider: "openai",
        triggerKind: "schedule",
        repoPrivate: true,
        automationConsentAt: null,
      })
    ).toMatchObject({ kind: "refused", reason: "no_consent" });
    // Public repositories and consent are Codex rules; Anthropic is unaffected.
    expect(
      await resolveFor(OWNER, "anthropic", { triggerKind: "schedule", repoPrivate: false })
    ).toMatchObject({ kind: "own" });
  });

  it("refuses kinds the home owner switched off", async () => {
    await registerHouseholdHomes();
    await homes.update("H1", { kindsEnabled: ["prompt"] });

    expect(await resolveFor(OWNER, "anthropic", { triggerKind: "mention" })).toMatchObject({
      kind: "refused",
      reason: "kind_disabled",
      homeId: "H1",
    });
  });

  it("orders shared homes by fewest running sessions, then oldest registration", async () => {
    await registerHouseholdHomes();
    await homes.register({
      id: "H3",
      ownerUserIds: ["user-third"],
      pvcName: "sf-home-third",
      nodeName: "sandbox-node-1",
      providers: ["anthropic"],
      shared: true,
      sharingConsentAt: REGISTERED_AT,
      now: REGISTERED_AT + 2,
    });

    // Tie at zero: the oldest registration wins.
    expect(await resolveFor(COLLEAGUE, "anthropic")).toMatchObject({ homeId: "H1" });

    await insertSession("s-1", "H1", "active");
    expect(await resolveFor(COLLEAGUE, "anthropic")).toMatchObject({
      kind: "shared",
      homeId: "H3",
    });

    // Finished sessions do not count, and a later tie goes back to the oldest home.
    await insertSession("s-2", "H3", "active");
    await insertSession("s-3", "H3", "completed");
    expect(await resolveFor(COLLEAGUE, "anthropic")).toMatchObject({ homeId: "H1" });
  });

  it("never lets quota state change the order", async () => {
    await registerHouseholdHomes();
    await homes.register({
      id: "H3",
      ownerUserIds: ["user-third"],
      pvcName: "sf-home-third",
      nodeName: "sandbox-node-1",
      providers: ["anthropic"],
      shared: true,
      sharingConsentAt: REGISTERED_AT,
      now: REGISTERED_AT + 2,
    });
    // The owner's quota is exhausted; the order still puts their older home first.
    await db
      .prepare(
        `INSERT INTO usage_quotas (id, scope_kind, scope_id, period, max_turns, action, created_by, created_at, updated_at)
         VALUES ('q-owner', 'user', ?, 'month', 0, 'block', ?, 1, 1)`
      )
      .bind(OWNER, OWNER)
      .run();

    expect(await resolveFor(COLLEAGUE, "anthropic")).toMatchObject({ homeId: "H1" });
  });

  it("skips a shared home at capacity and refuses the owner's own home when it is full", async () => {
    await registerHouseholdHomes();
    await homes.update("H1", { maxConcurrent: 1 });
    await insertSession("s-1", "H1", "active");

    expect(await resolveFor(OWNER, "anthropic")).toMatchObject({
      kind: "refused",
      reason: "auth_home_unavailable",
      homeId: "H1",
    });
    expect(await resolveFor(COLLEAGUE, "anthropic")).toMatchObject({
      kind: "refused",
      reason: "auth_home_unavailable",
    });
  });

  it("queues a Codex session for a busy home instead of refusing it, and only Codex", async () => {
    await homes.register({
      id: "HX",
      ownerUserIds: [OWNER],
      pvcName: "sf-home-codex-owner",
      nodeName: "sandbox-node-1",
      providers: ["openai"],
      maxConcurrent: 1,
      now: REGISTERED_AT,
    });
    await insertSession("s-busy", "HX", "active");
    const forHarness = (harness: "codex" | "opencode") =>
      resolveAuthHome({
        db,
        actorUserId: OWNER,
        provider: "openai",
        triggerKind: "prompt",
        repoPrivate: true,
        harness,
      });

    expect(await forHarness("codex")).toEqual({
      kind: "own",
      homeId: "HX",
      homeOwnerUserId: OWNER,
    });
    expect(await forHarness("opencode")).toMatchObject({
      kind: "refused",
      reason: "auth_home_unavailable",
    });
    // The seat does not lift the other Codex gates.
    expect(
      await resolveAuthHome({
        db,
        actorUserId: OWNER,
        provider: "openai",
        triggerKind: "prompt",
        repoPrivate: false,
        harness: "codex",
      })
    ).toMatchObject({ kind: "refused", reason: "public_repo" });
  });

  it("ignores disabled homes", async () => {
    await registerHouseholdHomes();
    await homes.update("H2", { status: "disabled" });

    // The colleague is no longer enrolled, so the shared home is out of reach too.
    expect(await resolveFor(COLLEAGUE, "zai-coding-plan")).toEqual({
      kind: "refused",
      reason: "no_eligible_home",
    });
    expect(await resolveFor(COLLEAGUE, "anthropic")).toEqual({
      kind: "refused",
      reason: "no_eligible_home",
    });
  });

  describe("checkTurnEligibility", () => {
    it("admits the owner always and an enrolled colleague only on a shared home under household", async () => {
      await registerHouseholdHomes();
      const check = (actorUserId: string | null) =>
        checkTurnEligibility({ db, actorUserId, homeId: "H1" });

      expect(await check(OWNER)).toEqual({ kind: "own", homeId: "H1", homeOwnerUserId: OWNER });
      expect(await check(COLLEAGUE)).toEqual({
        kind: "shared",
        homeId: "H1",
        homeOwnerUserId: OWNER,
      });
      expect(await check(UNENROLLED)).toMatchObject({
        kind: "refused",
        reason: "no_eligible_home",
      });

      await homes.update("H1", { shared: false, sharingConsentAt: null });
      expect(await check(COLLEAGUE)).toMatchObject({ kind: "refused", reason: "sharing_off" });

      await homes.update("H1", { shared: true, sharingConsentAt: REGISTERED_AT });
      await new SubscriptionSharingStore(db).set("owner_only", OWNER);
      expect(await check(COLLEAGUE)).toMatchObject({
        kind: "refused",
        reason: "no_eligible_home",
      });
      expect(await check(OWNER)).toMatchObject({ kind: "own" });
    });

    it("refuses every turn on a removed or disabled home", async () => {
      await registerHouseholdHomes();
      await homes.update("H1", { status: "disabled" });
      expect(await checkTurnEligibility({ db, actorUserId: OWNER, homeId: "H1" })).toMatchObject({
        kind: "refused",
        reason: "auth_home_unavailable",
      });
      expect(await checkTurnEligibility({ db, actorUserId: OWNER, homeId: "missing" })).toEqual({
        kind: "refused",
        reason: "auth_home_unavailable",
      });
    });
  });
});
