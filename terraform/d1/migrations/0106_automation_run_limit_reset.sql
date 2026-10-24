-- Let an automation run wait out a subscription limit instead of failing.
--
-- A run whose session stopped at a usage limit (or on an overloaded provider)
-- moves to status 'waiting_for_reset' while its session continues on its own
-- at resume_at. `outcome` records why the run last stopped short of success
-- ('usage_limited', 'overloaded'); outcomes in NON_STRIKE_OUTCOMES never count
-- toward the consecutive-failure auto-pause. Both columns are NULL on every
-- existing row, which keeps today's behavior for them.

ALTER TABLE automation_runs ADD COLUMN resume_at INTEGER;
ALTER TABLE automation_runs ADD COLUMN outcome TEXT;

-- The recovery sweep fails a waiting run whose resumed turn never reported
-- back by its deadline. Keep `status` a literal (see migration 0024) so the
-- planner uses this partial index instead of scanning the append-only table.
CREATE INDEX IF NOT EXISTS idx_runs_waiting_sweep
  ON automation_runs (execution_deadline_at)
  WHERE status = 'waiting_for_reset';
