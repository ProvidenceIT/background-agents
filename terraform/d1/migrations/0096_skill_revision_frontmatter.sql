-- Preserved SKILL.md frontmatter beyond the structured fields (for example
-- disable-model-invocation or argument-hint), as canonical JSON per revision.
-- Existing revisions carry none, which renders no extra SKILL.md bytes, so
-- their stored files and revision digests stay valid.
ALTER TABLE skill_revisions ADD COLUMN frontmatter_json TEXT NOT NULL DEFAULT '{}';
