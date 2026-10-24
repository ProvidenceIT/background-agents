-- Protected-path holds (FACTORY_RULES hold categories, deterministic layer).
--
-- repo_path_policies: per-repository protected globs added on top of the
-- shared DEFAULT_PROTECTED_PATHS (never removing a default). Keyed by the
-- lowercased owner/name like repo_metadata. `globs` is a JSON array of
-- {glob, category}; `updated_by` is the canonical user id of the last editor.
CREATE TABLE repo_path_policies (
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  globs TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_owner, repo_name)
);

-- The protected-path check result for a session PR. `held_at_sha` is the
-- head SHA the check last evaluated; `hold_reason` is the JSON array of
-- matched {path, category, glob} at that SHA, or NULL when nothing matched.
-- A held_at_sha that differs from the PR's head means the current head has
-- not been checked yet, which the merge gate treats as held.
ALTER TABLE session_pull_requests ADD COLUMN hold_reason TEXT;
ALTER TABLE session_pull_requests ADD COLUMN held_at_sha TEXT;
