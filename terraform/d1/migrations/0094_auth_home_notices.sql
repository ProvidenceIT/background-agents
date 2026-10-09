-- Token expiry of a subscription home, and the notices its owner is sent.
--
-- user_auth_homes.claude_expires_at: when the Claude setup token in the home
-- expires, in epoch milliseconds, as a sandbox mounting the home reports it
-- at boot from the claude/expires_at file written next to the token. Null
-- until a sandbox has reported it. The control plane never reads the token.
--
-- 0092 and 0093 are reserved for the Codex harness slice (harness CHECK
-- rebuild and the auth-home lease tables); this migration touches neither.
ALTER TABLE user_auth_homes ADD COLUMN claude_expires_at INTEGER;

-- auth_home_notices: one row per notice owed to a home owner, claimed before
-- it is posted so a notice goes out at most once across ticks and hosts.
-- kind 'claude_expiry' is the T-14d expiry notice (period_key: the expiry it
-- warns about, so a re-minted token earns its own notice); 'weekly_digest'
-- lists the sessions the home served in one week (period_key: the UTC date
-- the week starts). sent_at stays null while the post is in flight; a claim
-- whose post failed is deleted so a later tick retries it.
CREATE TABLE auth_home_notices (
  home_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('claude_expiry', 'weekly_digest')),
  period_key TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  sent_at INTEGER,
  PRIMARY KEY (home_id, kind, period_key)
);

-- The weekly digest reads one home's sessions over one week.
CREATE INDEX idx_sessions_auth_home_created ON sessions(auth_home_id, created_at);
