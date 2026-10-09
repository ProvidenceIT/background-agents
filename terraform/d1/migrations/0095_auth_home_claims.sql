-- auth_home_claims: which person a subscription-home claim belongs to.
--
-- An operator creates a home's volume and claim (sf-home-<suffix>) for one
-- person and records that assignment here. A user registers a home only on
-- a claim assigned to them, so nobody can bind another person's volume to
-- their own sessions; the claim of a registered home cannot be changed.
-- The row outlives the home, so the owner can re-register after removing it
-- and nobody else can take the claim in between. A home's Codex claim
-- (sf-home-<suffix>-codex) follows its home and is never assigned itself.
CREATE TABLE auth_home_claims (
  pvc_name TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  assigned_by TEXT,
  assigned_at INTEGER NOT NULL
);

CREATE INDEX idx_auth_home_claims_owner ON auth_home_claims(owner_user_id);
