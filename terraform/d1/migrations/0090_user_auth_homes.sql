-- Subscription auth homes and the workspace sharing policy.
--
-- user_auth_homes: one row per enrolled person's home, a directory on a node
-- the person administers that a sandbox mounts through the claim pvc_name.
-- The control plane never stores a credential here: the row records who the
-- home serves (owner_user_ids, a JSON array whose first element is the home
-- owner and the rest the same person's merged identities), which providers'
-- credential files it carries (providers, JSON array), which trigger kinds
-- may run on it (kinds_enabled, JSON array), the consent timestamps, and
-- whether the owner offers it to the other enrolled people (shared).
-- JSON arrays are read and written as text by the store; nothing queries
-- inside them with engine functions.
CREATE TABLE user_auth_homes (
  id TEXT PRIMARY KEY,
  owner_user_ids TEXT NOT NULL,
  pvc_name TEXT NOT NULL UNIQUE,
  node_name TEXT NOT NULL,
  providers TEXT NOT NULL,
  kinds_enabled TEXT NOT NULL,
  background_consent_at INTEGER,
  max_concurrent INTEGER NOT NULL DEFAULT 3 CHECK (max_concurrent > 0),
  shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
  sharing_consent_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  registered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (shared = 0 OR sharing_consent_at IS NOT NULL)
);

CREATE INDEX idx_user_auth_homes_shared ON user_auth_homes(status, shared, registered_at);

-- subscription_sharing: the single-row workspace setting (id = 'global'),
-- after the model_preferences pattern. An absent row reads as 'household',
-- the default: a turn with no own home may run on a colleague's shared home.
-- 'owner_only' restores own-home-or-refuse with one write.
CREATE TABLE subscription_sharing (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  policy TEXT NOT NULL DEFAULT 'household' CHECK (policy IN ('owner_only', 'household')),
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);
