/**
 * The `CacheStore` conformance suite — the one the control plane runs on KV,
 * D1 and its own `node:sqlite` file — on the GitHub bot's Node cache file,
 * opened exactly as the runtime opens it.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  registerCacheStoreConformanceSuite,
  type CacheStoreFactory,
} from "../../control-plane/test/conformance/cache-store-conformance";
import { CACHE_DATABASE_FILE, openNodeCacheDatabase } from "../src/node/cache-database";

function withCacheDatabase<T>(
  run: (
    opened: ReturnType<typeof openNodeCacheDatabase>,
    advance: (ms: number) => void,
    dir: string
  ) => Promise<T>
): Promise<T> {
  const stateDir = mkdtempSync(join(tmpdir(), "github-bot-cache-"));
  let offsetMs = 0;
  const opened = openNodeCacheDatabase(stateDir, { now: () => Date.now() + offsetMs });
  return run(
    opened,
    (ms) => {
      offsetMs += ms;
    },
    stateDir
  ).finally(() => {
    opened.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
}

const sqliteFactory: CacheStoreFactory = (run) =>
  withCacheDatabase(({ store }, advance) => run({ store, advance }));

registerCacheStoreConformanceSuite(sqliteFactory, { controllableClock: true });

describe("GitHub bot Node cache file", () => {
  it("is private to the process user", async () => {
    await withCacheDatabase(async (_opened, _advance, stateDir) => {
      expect(statSync(join(stateDir, CACHE_DATABASE_FILE)).mode & 0o777).toBe(0o600);
    });
  });

  it("sweeps entries past their TTL and keeps live and TTL-less ones", async () => {
    await withCacheDatabase(async ({ store }, advance) => {
      await store.put("expired", "a", { expirationTtl: 60 });
      await store.put("live", "b", { expirationTtl: 600 });
      await store.put("forever", "c");
      advance(60_001);

      await store.deleteExpired();
      // Moving the clock back shows the row is gone, not merely read as expired.
      advance(-60_001);

      expect(await store.get("expired")).toBeNull();
      expect(await store.get("live")).toBe("b");
      expect(await store.get("forever")).toBe("c");
    });
  });
});
