-- Fork lineage, kept apart from parent_session_id so a fork never counts
-- toward a parent's child quota or spawn depth. fork_request_id is the
-- caller's idempotency key for POST /sessions/:id/fork; both columns are NULL
-- on sessions that are not forks, and NULLs never collide in the index.
ALTER TABLE sessions ADD COLUMN forked_from_session_id TEXT;
ALTER TABLE sessions ADD COLUMN fork_request_id TEXT;
CREATE UNIQUE INDEX idx_sessions_fork_request
  ON sessions(forked_from_session_id, fork_request_id);
