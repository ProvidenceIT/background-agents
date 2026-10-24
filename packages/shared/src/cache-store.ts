export interface CacheStorePutOptions {
  expirationTtl?: number;
}

export interface CacheStore {
  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown | null>;
  put(key: string, value: string, opts?: CacheStorePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

interface KvCacheNamespace {
  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown | null>;
  put(key: string, value: string, opts?: CacheStorePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createKvCacheStore(kv: KvCacheNamespace): CacheStore {
  function get(key: string): Promise<string | null>;
  function get(key: string, type: "json"): Promise<unknown | null>;
  function get(key: string, type?: "json"): Promise<string | unknown | null> {
    return type === "json" ? kv.get(key, "json") : kv.get(key);
  }

  return {
    get,
    put: (key, value, opts) => (opts ? kv.put(key, value, opts) : kv.put(key, value)),
    delete: (key) => kv.delete(key),
  };
}

/*
 * `CacheStore` over a SQL table, for hosts that have no KV: the control
 * plane's Node host and the bots' Node entries.
 *
 * It is engine-neutral — it runs on any database with D1's `prepare / bind /
 * first / run` shape, D1 and `node:sqlite` adapters alike — so it lives with
 * the port rather than with any one host. Each host keeps the table in a file
 * of its own, applied from `CACHE_ENTRIES_SCHEMA_SQL` on open; nothing on
 * Cloudflare reads it, so it is not in `terraform/d1/migrations`.
 *
 * Expiry is by comparison on read, and reads do not write: a row past its TTL
 * reads as absent and is left where it is. Nothing reclaims it. The control
 * plane's key space is two singletons, overwritten by the refresh a miss
 * triggers. The GitHub bot's delivery keys are one per webhook delivery and
 * are never overwritten, so it sweeps them itself (`deleteExpired`).
 */

/**
 * The table this store reads and writes, as one statement so any engine can
 * apply it. Values are opaque strings; `expires_at` is epoch milliseconds,
 * NULL for an entry that never expires.
 */
export const CACHE_ENTRIES_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS cache_entries (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
)`;

/** One prepared statement: the subset of D1's statement the store uses. */
export interface CacheSqlStatement {
  bind(...values: unknown[]): CacheSqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

/** The SQL surface `SqlCacheStore` needs; D1 and the hosts' SQLite ports satisfy it. */
export interface CacheSqlDatabase {
  prepare(query: string): CacheSqlStatement;
}

interface CacheEntryRow {
  value: string;
  /** Epoch ms after which the entry reads as absent; `null` never expires. */
  expires_at: number | null;
}

export interface SqlCacheStoreOptions {
  /** Epoch milliseconds; injected so expiry is testable without waiting. */
  now?: () => number;
}

export class SqlCacheStore implements CacheStore {
  private readonly now: () => number;

  constructor(
    private readonly db: CacheSqlDatabase,
    options: SqlCacheStoreOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown | null>;
  async get(key: string, type?: "json"): Promise<string | unknown | null> {
    const row = await this.db
      .prepare("SELECT value, expires_at FROM cache_entries WHERE key = ?")
      .bind(key)
      .first<CacheEntryRow>();
    if (!row) return null;
    // Deliberately no delete here. Cleaning up on read would put a write in
    // the read path and race the refresh this miss is about to trigger.
    if (row.expires_at !== null && row.expires_at <= this.now()) return null;
    return type === "json" ? JSON.parse(row.value) : row.value;
  }

  async put(key: string, value: string, opts?: CacheStorePutOptions): Promise<void> {
    const ttlSeconds = opts?.expirationTtl;
    const expiresAt = ttlSeconds === undefined ? null : this.now() + ttlSeconds * 1000;
    await this.db
      .prepare(
        `INSERT INTO cache_entries (key, value, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`
      )
      .bind(key, value, expiresAt)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM cache_entries WHERE key = ?").bind(key).run();
  }

  /** Remove every entry whose TTL has passed, for a host whose keys are not overwritten. */
  async deleteExpired(): Promise<void> {
    await this.db
      .prepare("DELETE FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .bind(this.now())
      .run();
  }
}
