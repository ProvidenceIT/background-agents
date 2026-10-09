-- One running Codex session per subscription home: a fenced lease and the
-- FIFO of sessions waiting for it.
--
-- Codex refreshes the single-use token in the home's auth.json itself, so two
-- sandboxes running Codex on one home would race the refresh. The lease is the
-- serialization: a row per (home, seat kind) naming the holding session and
-- its last heartbeat. A holder whose heartbeat is older than the expiry is
-- fenced (its pods are deleted and must be gone from the API server) before
-- the seat moves on; fenced_at marks a fence in progress.
--
-- pod_name records the holder's sandbox object for operators; fencing finds
-- pods by the claim they mount, never by this column.
CREATE TABLE auth_home_leases (
  home_id TEXT NOT NULL REFERENCES user_auth_homes(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  pod_name TEXT,
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  fenced_at INTEGER,
  PRIMARY KEY (home_id, provider)
);

CREATE INDEX idx_auth_home_leases_session ON auth_home_leases(session_id);

-- Waiting sessions, served oldest first. A waiter refreshes last_seen_at each
-- time it asks again; one that stops asking (its prompt was cancelled, the
-- session archived) drops out of the order once its entry goes stale.
CREATE TABLE auth_home_lease_queue (
  home_id TEXT NOT NULL REFERENCES user_auth_homes(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (home_id, provider, session_id)
);

CREATE INDEX idx_auth_home_lease_queue_order
  ON auth_home_lease_queue(home_id, provider, enqueued_at);
CREATE INDEX idx_auth_home_lease_queue_session ON auth_home_lease_queue(session_id);
