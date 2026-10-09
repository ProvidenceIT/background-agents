-- The Codex harness joins the harness discriminator (opencode, claude, codex).
--
-- 0075 put the allowed values in a column CHECK, which SQLite cannot alter in
-- place. Rebuilding sessions or automations would mean recreating every
-- index, trigger and foreign key that names them, so each table swaps the
-- column instead: add a successor under the new CHECK, copy the values, drop
-- the old column (allowed: nothing but its own CHECK refers to it) and give
-- the successor the old name. Every statement is plain ALTER TABLE / UPDATE.
-- The column moves to the end of each table; nothing reads it by position.
ALTER TABLE sessions ADD COLUMN harness_next TEXT NOT NULL DEFAULT 'opencode'
  CHECK (harness_next IN ('opencode', 'claude', 'codex'));
UPDATE sessions SET harness_next = harness;
ALTER TABLE sessions DROP COLUMN harness;
ALTER TABLE sessions RENAME COLUMN harness_next TO harness;

ALTER TABLE automations ADD COLUMN harness_next TEXT NOT NULL DEFAULT 'opencode'
  CHECK (harness_next IN ('opencode', 'claude', 'codex'));
UPDATE automations SET harness_next = harness;
ALTER TABLE automations DROP COLUMN harness;
ALTER TABLE automations RENAME COLUMN harness_next TO harness;
