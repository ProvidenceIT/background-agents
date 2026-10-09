import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listMigrations } from "../node/migrate";

const MIGRATIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../terraform/d1/migrations"
);

function applyThrough(db: DatabaseSync, upTo: string): void {
  for (const file of listMigrations(MIGRATIONS).filter((entry) => entry.version <= upTo)) {
    db.exec(readFileSync(file.path, "utf8"));
  }
}

function migration(version: string): string {
  const file = listMigrations(MIGRATIONS).find((entry) => entry.version === version);
  if (!file) throw new Error(`migration ${version} is missing`);
  return readFileSync(file.path, "utf8");
}

function schemaObjects(db: DatabaseSync, table: string): unknown[] {
  return db
    .prepare(
      "SELECT type, name FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') ORDER BY type, name"
    )
    .all(table);
}

describe("migration 0092 (codex harness)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    applyThrough(db, "0091");
    db.exec(
      `INSERT INTO users (id, display_name, created_at, updated_at) VALUES ('u1', 'u1', 1, 1);
       INSERT INTO sessions (id, user_id, harness, created_at, updated_at)
         VALUES ('s-opencode', 'u1', 'opencode', 1, 1), ('s-claude', 'u1', 'claude', 2, 2);
       INSERT INTO sessions (id, user_id, parent_session_id, created_at, updated_at)
         VALUES ('s-child', 'u1', 's-claude', 3, 3);
       INSERT INTO automations (id, name, instructions, model, harness, created_by, created_at, updated_at)
         VALUES ('a1', 'nightly', 'run', 'anthropic/claude-sonnet-4-6', 'claude', 'u1', 1, 1);`
    );
  });
  afterEach(() => db.close());

  it("keeps every row, its harness, the indexes and the triggers", () => {
    const sessionObjects = schemaObjects(db, "sessions");
    const automationObjects = schemaObjects(db, "automations");

    db.exec(migration("0092"));

    expect(db.prepare("SELECT id, harness FROM sessions ORDER BY created_at").all()).toEqual([
      { id: "s-opencode", harness: "opencode" },
      { id: "s-claude", harness: "claude" },
      { id: "s-child", harness: "opencode" },
    ]);
    expect(db.prepare("SELECT id, harness FROM automations").all()).toEqual([
      { id: "a1", harness: "claude" },
    ]);
    expect(schemaObjects(db, "sessions")).toEqual(sessionObjects);
    expect(schemaObjects(db, "automations")).toEqual(automationObjects);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("admits codex, defaults to opencode and still refuses an unknown harness", () => {
    db.exec(migration("0092"));

    db.exec(
      `INSERT INTO sessions (id, harness, created_at, updated_at) VALUES ('s-codex', 'codex', 4, 4);
       INSERT INTO sessions (id, created_at, updated_at) VALUES ('s-default', 5, 5);
       INSERT INTO automations (id, name, instructions, model, harness, created_by, created_at, updated_at)
         VALUES ('a2', 'codex', 'run', 'openai/gpt-6-sol', 'codex', 'u1', 2, 2);`
    );
    expect(
      db.prepare("SELECT id, harness FROM sessions WHERE id IN ('s-codex', 's-default')").all()
    ).toEqual([
      { id: "s-codex", harness: "codex" },
      { id: "s-default", harness: "opencode" },
    ]);
    expect(() =>
      db.exec(
        "INSERT INTO sessions (id, harness, created_at, updated_at) VALUES ('s-pi', 'pi', 6, 6)"
      )
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.exec(
        `INSERT INTO automations (id, name, instructions, model, harness, created_by, created_at, updated_at)
           VALUES ('a3', 'pi', 'run', 'openai/gpt-6-sol', 'pi', 'u1', 3, 3)`
      )
    ).toThrow(/CHECK constraint failed/);
  });
});
