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

const insertAutomation = (id: string, model: string, harness: string) =>
  `INSERT INTO automations (id, name, instructions, model, harness, created_by, created_at, updated_at)
     VALUES ('${id}', '${id}', 'run', '${model}', '${harness}', 'u1', 1, 1);`;

describe("migration 0102 (grok and agy harnesses, Anthropic on Claude Agent)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    applyThrough(db, "0101");
    db.exec(
      `INSERT INTO users (id, display_name, created_at, updated_at) VALUES ('u1', 'u1', 1, 1);
       INSERT INTO sessions (id, user_id, harness, model, created_at, updated_at)
         VALUES ('s-opencode', 'u1', 'opencode', 'anthropic/claude-sonnet-4-6', 1, 1),
                ('s-codex', 'u1', 'codex', 'openai/gpt-6-sol', 2, 2);
       ${insertAutomation("a-anthropic", "anthropic/claude-sonnet-4-6", "opencode")}
       ${insertAutomation("a-bare-claude", "claude-sonnet-4-6", "opencode")}
       ${insertAutomation("a-no-slash", "sonnet", "opencode")}
       ${insertAutomation("a-bare-gpt", "gpt-5.4", "opencode")}
       ${insertAutomation("a-xai", "xai/grok-4.7", "opencode")}
       ${insertAutomation("a-codex", "openai/gpt-6-sol", "codex")}
       ${insertAutomation("a-claude", "anthropic/claude-opus-4-7", "claude")}
       INSERT INTO integration_settings (integration_id, settings, created_at, updated_at)
         VALUES ('github', '{"defaults":{"harness":"opencode","model":"anthropic/claude-sonnet-4-6"}}', 1, 1),
                ('linear', '{"defaults":{"harness":"opencode","model":"xai/grok-4.7"}}', 1, 1);
       INSERT INTO integration_repo_settings (integration_id, repo, settings, created_at, updated_at)
         VALUES ('github', 'acme/web', '{"model":"anthropic/claude-sonnet-4-6","harness":"opencode"}', 1, 1);`
    );
  });
  afterEach(() => db.close());

  it("keeps every session and its harness, the indexes and the triggers", () => {
    const sessionObjects = schemaObjects(db, "sessions");
    const automationObjects = schemaObjects(db, "automations");

    db.exec(migration("0102"));

    expect(db.prepare("SELECT id, harness FROM sessions ORDER BY created_at").all()).toEqual([
      { id: "s-opencode", harness: "opencode" },
      { id: "s-codex", harness: "codex" },
    ]);
    expect(schemaObjects(db, "sessions")).toEqual(sessionObjects);
    expect(schemaObjects(db, "automations")).toEqual(automationObjects);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("moves OpenCode automations on Anthropic models to Claude Agent and leaves the rest", () => {
    db.exec(migration("0102"));

    expect(db.prepare("SELECT id, harness FROM automations ORDER BY id").all()).toEqual([
      { id: "a-anthropic", harness: "claude" },
      { id: "a-bare-claude", harness: "claude" },
      // A bare gpt-* id is OpenAI's (normalizeModelId), so it stays on OpenCode.
      { id: "a-bare-gpt", harness: "opencode" },
      { id: "a-claude", harness: "claude" },
      { id: "a-codex", harness: "codex" },
      { id: "a-no-slash", harness: "claude" },
      { id: "a-xai", harness: "opencode" },
    ]);
  });

  it("moves an OpenCode + Anthropic integration default to Claude Agent", () => {
    db.exec(migration("0102"));

    expect(
      db.prepare("SELECT integration_id, settings FROM integration_settings ORDER BY 1").all()
    ).toEqual([
      {
        integration_id: "github",
        settings: '{"defaults":{"harness":"claude","model":"anthropic/claude-sonnet-4-6"}}',
      },
      {
        integration_id: "linear",
        settings: '{"defaults":{"harness":"opencode","model":"xai/grok-4.7"}}',
      },
    ]);
    expect(db.prepare("SELECT settings FROM integration_repo_settings").all()).toEqual([
      { settings: '{"model":"anthropic/claude-sonnet-4-6","harness":"claude"}' },
    ]);
  });

  it("admits grok and agy, defaults to opencode and still refuses an unknown harness", () => {
    db.exec(migration("0102"));

    db.exec(
      `INSERT INTO sessions (id, harness, created_at, updated_at)
         VALUES ('s-grok', 'grok', 3, 3), ('s-agy', 'agy', 4, 4);
       INSERT INTO sessions (id, created_at, updated_at) VALUES ('s-default', 5, 5);
       ${insertAutomation("a-grok", "xai/grok-4.7-build-fast", "grok")}
       ${insertAutomation("a-agy", "antigravity/gemini-4-argon", "agy")}`
    );
    expect(
      db
        .prepare(
          "SELECT id, harness FROM sessions WHERE id IN ('s-grok', 's-agy', 's-default') ORDER BY created_at"
        )
        .all()
    ).toEqual([
      { id: "s-grok", harness: "grok" },
      { id: "s-agy", harness: "agy" },
      { id: "s-default", harness: "opencode" },
    ]);
    expect(
      db
        .prepare("SELECT id, harness FROM automations WHERE id IN ('a-grok', 'a-agy') ORDER BY id")
        .all()
    ).toEqual([
      { id: "a-agy", harness: "agy" },
      { id: "a-grok", harness: "grok" },
    ]);
    expect(() =>
      db.exec(
        "INSERT INTO sessions (id, harness, created_at, updated_at) VALUES ('s-pi', 'pi', 6, 6)"
      )
    ).toThrow(/CHECK constraint failed/);
    expect(() => db.exec(insertAutomation("a-pi", "openai/gpt-6-sol", "pi"))).toThrow(
      /CHECK constraint failed/
    );
  });
});
