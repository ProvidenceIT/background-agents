-- The subscription-home slot a settled turn spent (`claude-3`, or `default`
-- for a home with one token), as the sandbox reports it on execution_complete.
-- NULL when the turn spent no home (API key, connected account) or the
-- sandbox predates the report. A slot name only, never an account identity.
ALTER TABLE usage_ledger ADD COLUMN subscription_slot TEXT;
CREATE INDEX idx_usage_ledger_session_slot ON usage_ledger(session_id, subscription_slot);
