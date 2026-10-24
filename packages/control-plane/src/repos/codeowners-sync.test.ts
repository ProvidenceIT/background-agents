import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "../auth/github-app";
import { RepoMetadataStore } from "../db/repo-metadata";
import type { Logger } from "../logger";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import {
  CODEOWNERS_SYNC_INTERVAL_MS,
  createCodeownersFileClient,
  syncCodeowners,
  type CodeownersFileClient,
} from "./codeowners-sync";

vi.mock("../auth/github-app", () => ({
  fetchWithTimeout: vi.fn(),
  getCachedInstallationToken: vi.fn(async () => "installation-token"),
  getGitHubAppConfig: vi.fn(() => null),
  getInstallationTokenCacheKey: vi.fn(async () => "cache-key"),
  invalidateInstallationTokenCache: vi.fn(async () => {}),
}));

const NOW = 1_700_000_000_000;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const OWNERSHIP = {
  ownerTeamId: null,
  tier: "T2",
  repoClass: "internal",
  domain: null,
  dependsOn: null,
} as const;

describe("syncCodeowners", () => {
  let db: NodeSqlDatabase;
  let store: RepoMetadataStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    const raw = new DatabaseSync(":memory:");
    applyMigrations(
      raw,
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
    );
    db = createNodeSqlDatabase(raw);
    store = new RepoMetadataStore(db);
    await store.setOwnership("acme", "owned", OWNERSHIP);
    await store.setOwnership("acme", "bare", OWNERSHIP);
    await store.setOwnership("acme", "hidden", OWNERSHIP);
    await store.upsert("acme", "catalog-only", { description: "not onboarded" });
  });
  afterEach(() => db.close());

  const files: Record<string, string | null> = {
    "acme/owned": "* @acme/platform\n/docs/ @ada\n",
    "acme/bare": null,
  };
  const client: CodeownersFileClient = {
    readCodeowners: vi.fn(async (owner: string, name: string) => {
      const key = `${owner}/${name}`;
      if (!(key in files)) throw new Error(`Repository ${key} is unreachable: 404`);
      return files[key]!;
    }),
  };

  it("records parsed rules, records no file as null, and leaves an unreachable repository due", async () => {
    expect(await syncCodeowners(db, client, log, NOW)).toEqual({
      synced: ["acme/bare", "acme/owned"],
      failed: ["acme/hidden"],
    });
    expect(await store.getOwnership("acme", "owned")).toMatchObject({
      codeowners: [
        { pattern: "*", owners: [{ kind: "team", handle: "@acme/platform" }] },
        { pattern: "/docs/", owners: [{ kind: "user", handle: "@ada" }] },
      ],
      codeownersSyncedAt: NOW,
    });
    expect(await store.getOwnership("acme", "bare")).toMatchObject({
      codeowners: null,
      codeownersSyncedAt: NOW,
    });
    expect(await store.getOwnership("acme", "hidden")).toMatchObject({ codeownersSyncedAt: null });
    expect(client.readCodeowners).not.toHaveBeenCalledWith("acme", "catalog-only");
  });

  it("reads each repository again only once a day has passed", async () => {
    await syncCodeowners(db, client, log, NOW);
    vi.mocked(client.readCodeowners).mockClear();

    expect(await syncCodeowners(db, client, log, NOW + 60_000)).toEqual({
      synced: [],
      failed: ["acme/hidden"],
    });
    expect(await syncCodeowners(db, client, log, NOW + CODEOWNERS_SYNC_INTERVAL_MS + 1)).toEqual({
      synced: ["acme/bare", "acme/owned"],
      failed: ["acme/hidden"],
    });
  });
});

describe("createCodeownersFileClient", () => {
  const config = { appId: "1", privateKey: "key", installationId: "2" } as never;
  const github = createCodeownersFileClient(config, { userAgent: "oi-test" });
  const respond = (routes: Record<string, Response>) =>
    vi.mocked(fetchWithTimeout).mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      return routes[path] ?? new Response("Not Found", { status: 404 });
    });

  beforeEach(() => vi.clearAllMocks());

  it("reads the first file in GitHub's lookup order through the installation", async () => {
    respond({
      "/repos/acme/widgets": Response.json({ id: 1 }),
      "/repos/acme/widgets/contents/CODEOWNERS": new Response("* @acme/root"),
      "/repos/acme/widgets/contents/docs/CODEOWNERS": new Response("* @acme/docs"),
    });

    expect(await github.readCodeowners("acme", "widgets")).toBe("* @acme/root");
    const calls = vi.mocked(fetchWithTimeout).mock.calls;
    expect(calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/repos/acme/widgets",
      "/repos/acme/widgets/contents/.github/CODEOWNERS",
      "/repos/acme/widgets/contents/CODEOWNERS",
    ]);
    expect(calls[1]![1]).toMatchObject({
      headers: { Authorization: "Bearer installation-token", Accept: "application/vnd.github.raw" },
    });
  });

  it("answers null when the repository has no file and throws when it is unreachable", async () => {
    respond({ "/repos/acme/widgets": Response.json({ id: 1 }) });
    expect(await github.readCodeowners("acme", "widgets")).toBeNull();

    respond({});
    await expect(github.readCodeowners("acme", "private")).rejects.toThrow(
      "Repository acme/private is unreachable: 404"
    );
  });
});
