-- Every connected provider account belongs to one user.
--
-- A subscription is spent only by its subscriber's own activity, so the
-- selection policy compares owner_user_id with the acting user and refuses
-- every other actor. The column is backfilled from created_by. Accounts whose
-- creator is gone keep the empty-string sentinel: NOT NULL without a nullable
-- default is what ALTER TABLE ADD COLUMN allows, '' maps to null in the API,
-- and such an account can be selected by nobody. No foreign key: SQLite does
-- not add a REFERENCES column with a non-NULL default, and users(id) rows are
-- merged rather than deleted.
ALTER TABLE model_provider_accounts ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT '';

UPDATE model_provider_accounts
SET owner_user_id = created_by
WHERE created_by IS NOT NULL AND owner_user_id = '';

CREATE INDEX idx_model_provider_accounts_owner
  ON model_provider_accounts(owner_user_id, provider);
