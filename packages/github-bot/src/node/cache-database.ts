/**
 * The delivery cache on Node: `cache.db` in the state directory, holding the
 * table `SqlCacheStore` uses — the store the control plane's Node host runs
 * for its own cache. On the Worker the same keys live in KV.
 *
 * The file is on a persistent volume so a webhook GitHub redelivers after a
 * restart is still recognised as a duplicate. Its entries expire (7 days for
 * a processed delivery), and unlike KV nothing drops them, so the runtime
 * sweeps expired rows on a timer.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  CACHE_ENTRIES_SCHEMA_SQL,
  SqlCacheStore,
  type CacheSqlDatabase,
  type CacheSqlStatement,
  type SqlCacheStoreOptions,
} from "@open-inspect/shared/cache-store";

export const CACHE_DATABASE_FILE = "cache.db";

/** How long a writer waits on another connection's lock before failing. */
const BUSY_TIMEOUT_MS = 5_000;

export interface NodeCacheDatabase {
  store: SqlCacheStore;
  close(): void;
}

/** The store's SQL port over an open connection; values bind as `node:sqlite` takes them. */
function sqliteCacheDatabase(db: DatabaseSync): CacheSqlDatabase {
  const statement = (query: string, params: SQLInputValue[]): CacheSqlStatement => ({
    bind: (...values) => statement(query, values as SQLInputValue[]),
    first: async <T>() => (db.prepare(query).get(...params) as T | undefined) ?? null,
    run: async () => {
      db.prepare(query).run(...params);
    },
  });
  return { prepare: (query) => statement(query, []) };
}

/** Open (creating if needed) the cache file in `stateDir`, private to the process user. */
export function openNodeCacheDatabase(
  stateDir: string,
  options: SqlCacheStoreOptions = {}
): NodeCacheDatabase {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, CACHE_DATABASE_FILE);
  const db = new DatabaseSync(path);
  try {
    // SQLite gives the -wal and -shm files the main file's mode.
    chmodSync(path, 0o600);
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(CACHE_ENTRIES_SCHEMA_SQL);
  } catch (error) {
    db.close();
    throw error;
  }
  return { store: new SqlCacheStore(sqliteCacheDatabase(db), options), close: () => db.close() };
}
