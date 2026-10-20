-- Periodic re-read of open pull requests (open-pull-request-sweep.ts): the
-- third freshness path, for PRs whose closing webhook was missed and whose
-- session nobody opens, so the read-through never runs.
--
-- 0041 kept this table free of operational columns, and this stamp is the one
-- exception. The sweep is bounded per run, and without a stamp it would starve
-- behind rows whose provider read keeps failing (repository gone, app
-- uninstalled): a failed read never bumps updated_at, so those rows would head
-- every batch forever. The sweep writes the stamp before it asks the session
-- to refresh, so a failing row moves to the back of the queue, which is the
-- back-off. Epoch ms; NULL means never swept. No writer other than the sweep
-- sets it.

ALTER TABLE session_pull_requests ADD COLUMN sweep_attempted_at INTEGER;

-- Serves the candidate scan (open rows grouped by session, ordered by stamp)
-- and the stamp write, both of which touch only open rows.
CREATE INDEX IF NOT EXISTS idx_spr_open_sweep
  ON session_pull_requests (session_id, sweep_attempted_at)
  WHERE lifecycle_state = 'open';
