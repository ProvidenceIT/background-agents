import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { RepoMetadataStore } from "./repo-metadata";
import { TeamStore } from "./teams";

const INPUT = {
  tier: "T1",
  repoClass: "internal",
  domain: "factory",
  dependsOn: ["providenceit/prompt-library"],
} as const;

describe("RepoMetadataStore ownership", () => {
  let sqlite: NodeSqlDatabase;
  let store: RepoMetadataStore;
  let teamId: string;

  beforeEach(async () => {
    const raw = new DatabaseSync(":memory:");
    applyMigrations(
      raw,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    sqlite = createNodeSqlDatabase(raw);
    store = new RepoMetadataStore(sqlite);
    teamId = (
      await new TeamStore(sqlite).create({ slug: "platform", name: "Platform", joinPolicy: "open" })
    ).id;
  });
  afterEach(() => sqlite.close());

  it("round-trips ownership without touching the catalog metadata", async () => {
    await store.upsert("ProvidenceIT", "Background-Agents", { description: "OI fork" });
    await store.setOwnership("ProvidenceIT", "Background-Agents", {
      ...INPUT,
      dependsOn: [...INPUT.dependsOn],
      ownerTeamId: teamId,
    });

    expect(await store.getOwnership("providenceit", "background-agents")).toEqual({
      repo: "providenceit/background-agents",
      ownerTeam: { id: teamId, slug: "platform", name: "Platform" },
      tier: "T1",
      repoClass: "internal",
      effectiveRepoClass: "internal",
      domain: "factory",
      dependsOn: ["providenceit/prompt-library"],
      codeowners: null,
      codeownersSyncedAt: null,
    });
    expect(await store.get("ProvidenceIT", "Background-Agents")).toEqual({
      description: "OI fork",
    });

    // The catalog upsert leaves ownership alone too.
    await store.upsert("ProvidenceIT", "Background-Agents", { description: "renamed" });
    expect((await store.getOwnership("ProvidenceIT", "Background-Agents"))?.tier).toBe("T1");
  });

  it("reads an unclassified repository as client and clears fields set to null", async () => {
    await store.setOwnership("acme", "widgets", { ...INPUT, dependsOn: null, ownerTeamId: teamId });
    await store.setOwnership("acme", "widgets", {
      ownerTeamId: null,
      tier: null,
      repoClass: null,
      domain: null,
      dependsOn: null,
    });
    expect(await store.getOwnership("acme", "widgets")).toMatchObject({
      ownerTeam: null,
      tier: null,
      repoClass: null,
      effectiveRepoClass: "client",
      dependsOn: null,
    });
    expect(await store.getOwnership("acme", "unknown")).toBeNull();
  });

  it("refuses a repo_class or tier outside the allowed values", async () => {
    for (const column of ["repo_class", "tier"]) {
      await expect(
        (async () =>
          sqlite
            .prepare(
              `INSERT INTO repo_metadata (repo_owner, repo_name, ${column}, created_at, updated_at)
               VALUES ('acme', 'bad', 'public', 1, 1)`
            )
            .run())()
      ).rejects.toThrow(/CHECK constraint failed/);
    }
  });

  it("lists onboarded repositories and the ones whose CODEOWNERS sync is due", async () => {
    await store.upsert("acme", "catalog-only", { description: "not onboarded" });
    await store.setOwnership("acme", "fresh", { ...INPUT, dependsOn: null, ownerTeamId: null });
    await store.setOwnership("acme", "stale", { ...INPUT, dependsOn: null, ownerTeamId: teamId });
    await store.setOwnership("acme", "never", { ...INPUT, dependsOn: null, ownerTeamId: null });
    const rules = [{ pattern: "*", owners: [{ kind: "team" as const, handle: "@acme/platform" }] }];
    await store.setCodeowners("acme", "fresh", rules, 2_000);
    await store.setCodeowners("acme", "stale", null, 500);

    expect((await store.listOwnership()).map((repo) => repo.repo)).toEqual([
      "acme/fresh",
      "acme/never",
      "acme/stale",
    ]);
    expect(await store.listCodeownersSyncDue(1_000)).toEqual([
      { owner: "acme", name: "never" },
      { owner: "acme", name: "stale" },
    ]);
    expect(await store.getOwnership("acme", "fresh")).toMatchObject({
      codeowners: rules,
      codeownersSyncedAt: 2_000,
    });
    expect(await store.getOwnership("acme", "stale")).toMatchObject({
      codeowners: null,
      codeownersSyncedAt: 500,
    });
  });
});
