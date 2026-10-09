import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, listMigrations } from "../node/migrate";

const MIGRATIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../terraform/d1/migrations"
);

/** Apply every migration whose version is at most `upTo`. */
function applyThrough(db: DatabaseSync, upTo: string): void {
  const files = listMigrations(MIGRATIONS).filter((file) => file.version <= upTo);
  db.exec(
    "CREATE TABLE IF NOT EXISTS _schema_migrations (version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))"
  );
  for (const file of files) {
    db.exec(readFileSync(file.path, "utf8"));
    db.prepare("INSERT INTO _schema_migrations (version, name) VALUES (?, ?)").run(
      file.version,
      file.name
    );
  }
}

describe("migrations 0089-0091 (subscription auth homes)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    applyThrough(db, "0088");
    db.exec(
      `INSERT INTO users (id, display_name, created_at, updated_at) VALUES ('u1', 'u1', 1, 1);
       INSERT INTO model_provider_accounts (id, provider, display_name, status, created_by, created_at, updated_at)
         VALUES ('owned', 'openai', 'Owned', 'active', 'u1', 1, 1),
                ('orphan', 'xai', 'Orphan', 'active', NULL, 1, 1);
       INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES ('s1', 'u1', 1, 1);`
    );
  });
  afterEach(() => db.close());

  it("applies on a 0088-level database, backfills owners and keeps every foreign key satisfied", () => {
    const applied = applyMigrations(db, MIGRATIONS);
    expect(applied).toEqual([
      "0089_provider_account_owner.sql",
      "0090_user_auth_homes.sql",
      "0091_session_trigger_fields.sql",
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db.prepare("SELECT id, owner_user_id FROM model_provider_accounts ORDER BY id").all()
    ).toEqual([
      { id: "orphan", owner_user_id: "" },
      { id: "owned", owner_user_id: "u1" },
    ]);
    // The legacy seed rows survive the provider-auth table rebuild.
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM session_model_provider_auth WHERE session_id = 's1'")
        .get()
    ).toEqual({ n: 3 });
  });

  it("admits auth_home provider-auth rows and still seeds new sessions", () => {
    applyMigrations(db, MIGRATIONS);
    db.exec("INSERT INTO sessions (id, user_id, created_at, updated_at) VALUES ('s2', 'u1', 2, 2)");
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM session_model_provider_auth WHERE session_id = 's2'")
        .get()
    ).toEqual({ n: 3 });
    db.prepare(
      `INSERT INTO session_model_provider_auth (session_id, provider, auth_mode, selection_source, created_at)
       VALUES ('s2', 'anthropic', 'auth_home', 'auth_home_own', 3)
       ON CONFLICT (session_id, provider) DO UPDATE SET
         auth_mode = excluded.auth_mode, selection_source = excluded.selection_source`
    ).run();
    expect(
      db
        .prepare(
          "SELECT auth_mode, provider_account_id FROM session_model_provider_auth WHERE session_id = 's2' AND provider = 'anthropic'"
        )
        .get()
    ).toEqual({ auth_mode: "auth_home", provider_account_id: null });
    expect(() =>
      db
        .prepare(
          `INSERT INTO session_model_provider_auth (session_id, provider, auth_mode, provider_account_id, selection_source, created_at)
           VALUES ('s2', 'openai', 'auth_home', 'owned', 'auth_home_own', 3)
           ON CONFLICT (session_id, provider) DO UPDATE SET auth_mode = excluded.auth_mode,
             provider_account_id = excluded.provider_account_id`
        )
        .run()
    ).toThrow(/CHECK constraint failed/);
  });

  it("constrains trigger kinds, home selections, the sharing policy and the singleton id", () => {
    applyMigrations(db, MIGRATIONS);
    db.exec(
      "UPDATE sessions SET trigger_actor_user_id = 'u1', trigger_kind = 'mention', auth_home_id = 'H1', auth_home_selection = 'shared' WHERE id = 's1'"
    );
    expect(() => db.exec("UPDATE sessions SET trigger_kind = 'user' WHERE id = 's1'")).toThrow(
      /CHECK constraint failed/
    );
    expect(() =>
      db.exec("UPDATE sessions SET auth_home_selection = 'borrowed' WHERE id = 's1'")
    ).toThrow(/CHECK constraint failed/);
    db.exec("UPDATE automations SET background_consent_at = NULL");

    db.exec(
      "INSERT INTO subscription_sharing (id, policy, updated_by, updated_at) VALUES ('global', 'owner_only', 'u1', 5)"
    );
    expect(() =>
      db.exec(
        "INSERT INTO subscription_sharing (id, policy, updated_at) VALUES ('other', 'household', 5)"
      )
    ).toThrow(/CHECK constraint failed/);
    expect(() => db.exec("UPDATE subscription_sharing SET policy = 'everyone'")).toThrow(
      /CHECK constraint failed/
    );

    db.exec(
      `INSERT INTO user_auth_homes (id, owner_user_ids, pvc_name, node_name, providers, kinds_enabled, shared, sharing_consent_at, registered_at, updated_at)
       VALUES ('H1', '["u1"]', 'sf-home-u1', 'agent.dokman.io', '["anthropic"]', '["prompt"]', 1, 7, 7, 7)`
    );
    expect(() =>
      db.exec(
        `INSERT INTO user_auth_homes (id, owner_user_ids, pvc_name, node_name, providers, kinds_enabled, shared, registered_at, updated_at)
         VALUES ('H2', '["u2"]', 'sf-home-u2', 'agent.dokman.io', '[]', '[]', 1, 7, 7)`
      )
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.exec(
        `INSERT INTO user_auth_homes (id, owner_user_ids, pvc_name, node_name, providers, kinds_enabled, registered_at, updated_at)
         VALUES ('H3', '["u3"]', 'sf-home-u1', 'agent.dokman.io', '[]', '[]', 7, 7)`
      )
    ).toThrow(/UNIQUE constraint failed/);
  });
});
