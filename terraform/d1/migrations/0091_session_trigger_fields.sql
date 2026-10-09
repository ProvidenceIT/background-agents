-- Who and what started a session, and which auth home serves it.
--
-- trigger_actor_user_id is the canonical user whose activity the session is;
-- trigger_kind says how it started; work_item_author_user_id is the author of
-- the issue or pull request a bot acted on (audited, never the actor);
-- auth_home_id / auth_home_selection record the resolver's verdict. All are
-- nullable: sessions created before this migration carry none of them.
ALTER TABLE sessions ADD COLUMN trigger_actor_user_id TEXT;
ALTER TABLE sessions ADD COLUMN trigger_kind TEXT
  CHECK (trigger_kind IN ('prompt', 'child', 'mention', 'issue_label', 'pr_event', 'schedule'));
ALTER TABLE sessions ADD COLUMN work_item_author_user_id TEXT;
ALTER TABLE sessions ADD COLUMN auth_home_id TEXT;
ALTER TABLE sessions ADD COLUMN auth_home_selection TEXT
  CHECK (auth_home_selection IN ('own', 'shared'));

-- The resolver orders shared homes by how many sessions they are serving.
CREATE INDEX idx_sessions_auth_home ON sessions(auth_home_id, status);

-- An automation's owner consents to its runs spending their home in the
-- background; an edit by anyone else clears it until the owner re-confirms.
ALTER TABLE automations ADD COLUMN background_consent_at INTEGER;

-- session_model_provider_auth admits auth_mode 'auth_home': the provider's own
-- CLI reads the credential from the mounted home, so the row names no
-- account. SQLite cannot widen a CHECK in place, so the table is rebuilt as
-- 0088 rebuilt team_channel_bindings. Nothing references this table by
-- foreign key. The 0076 seed trigger on sessions inserts into it by name:
-- a rename refuses while a trigger points at the dropped name, so the trigger
-- is dropped first and re-created verbatim afterwards.
DROP TRIGGER IF EXISTS sessions_seed_legacy_provider_auth;

CREATE TABLE session_model_provider_auth_new (
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  provider_account_id TEXT,
  selection_source TEXT NOT NULL,
  inherited_from_session_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, provider),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_account_id, provider)
    REFERENCES model_provider_accounts(id, provider),
  CHECK (auth_mode IN ('provider_account', 'api_key', 'legacy_scoped_oauth', 'auth_home')),
  CHECK (
    (auth_mode = 'provider_account' AND provider_account_id IS NOT NULL)
    OR (auth_mode IN ('api_key', 'legacy_scoped_oauth', 'auth_home')
      AND provider_account_id IS NULL)
  )
);

INSERT INTO session_model_provider_auth_new
  (session_id, provider, auth_mode, provider_account_id, selection_source,
   inherited_from_session_id, created_at)
SELECT session_id, provider, auth_mode, provider_account_id, selection_source,
       inherited_from_session_id, created_at
FROM session_model_provider_auth;

DROP TABLE session_model_provider_auth;
ALTER TABLE session_model_provider_auth_new RENAME TO session_model_provider_auth;

CREATE INDEX idx_session_model_provider_auth_account
  ON session_model_provider_auth(provider_account_id, created_at)
  WHERE provider_account_id IS NOT NULL;

-- Re-created unchanged from 0076; the control plane upserts over these rows
-- at create with the resolved selections.
CREATE TRIGGER sessions_seed_legacy_provider_auth
AFTER INSERT ON sessions
BEGIN
  INSERT INTO session_model_provider_auth
    (session_id, provider, auth_mode, selection_source, created_at)
  VALUES (NEW.id, 'openai', 'legacy_scoped_oauth', 'legacy_migration', NEW.created_at);
  INSERT INTO session_model_provider_auth
    (session_id, provider, auth_mode, selection_source, created_at)
  VALUES (NEW.id, 'xai', 'legacy_scoped_oauth', 'legacy_migration', NEW.created_at);
  INSERT INTO session_model_provider_auth
    (session_id, provider, auth_mode, selection_source, created_at)
  VALUES (NEW.id, 'anthropic', 'api_key', 'legacy_migration', NEW.created_at);
END;
