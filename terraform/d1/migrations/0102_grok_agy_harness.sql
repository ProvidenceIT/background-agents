-- The SuperGrok (grok) and Antigravity (agy) harnesses join the harness
-- discriminator, and Anthropic models move to Claude Agent: OpenCode no
-- longer runs them.
--
-- The CHECK swap is the 0092 pattern: add a successor column under the new
-- CHECK, copy the values, drop the old column and give the successor the old
-- name, so no index, trigger or foreign key on sessions or automations is
-- rebuilt.
ALTER TABLE sessions ADD COLUMN harness_next TEXT NOT NULL DEFAULT 'opencode'
  CHECK (harness_next IN ('opencode', 'claude', 'codex', 'grok', 'agy'));
UPDATE sessions SET harness_next = harness;
ALTER TABLE sessions DROP COLUMN harness;
ALTER TABLE sessions RENAME COLUMN harness_next TO harness;

ALTER TABLE automations ADD COLUMN harness_next TEXT NOT NULL DEFAULT 'opencode'
  CHECK (harness_next IN ('opencode', 'claude', 'codex', 'grok', 'agy'));
UPDATE automations SET harness_next = harness;
ALTER TABLE automations DROP COLUMN harness;
ALTER TABLE automations RENAME COLUMN harness_next TO harness;

-- An OpenCode automation on an Anthropic model would fail its next run, so it
-- moves to Claude Agent. A model id with no provider prefix is an Anthropic
-- one, except a bare gpt-* id, which the shared code reads as OpenAI
-- (normalizeModelId). Sessions keep their harness (fixed at create); their
-- next turn is refused with a hint to fork onto Claude Agent.
UPDATE automations SET harness = 'claude'
  WHERE harness = 'opencode'
    AND (model LIKE 'anthropic/%' OR (model NOT LIKE '%/%' AND model NOT LIKE 'gpt-%'));

-- Integration settings saved an OpenCode + Anthropic pair that the next save
-- would refuse. The store writes them with JSON.stringify, one harness per
-- row (top level, or under `defaults` globally), so the pair is matched and
-- rewritten as text.
UPDATE integration_settings
  SET settings = REPLACE(settings, '"harness":"opencode"', '"harness":"claude"')
  WHERE settings LIKE '%"harness":"opencode"%'
    AND (settings LIKE '%"model":"anthropic/%' OR settings LIKE '%"model":"claude-%');
UPDATE integration_repo_settings
  SET settings = REPLACE(settings, '"harness":"opencode"', '"harness":"claude"')
  WHERE settings LIKE '%"harness":"opencode"%'
    AND (settings LIKE '%"model":"anthropic/%' OR settings LIKE '%"model":"claude-%');
UPDATE integration_environment_settings
  SET settings = REPLACE(settings, '"harness":"opencode"', '"harness":"claude"')
  WHERE settings LIKE '%"harness":"opencode"%'
    AND (settings LIKE '%"model":"anthropic/%' OR settings LIKE '%"model":"claude-%');
