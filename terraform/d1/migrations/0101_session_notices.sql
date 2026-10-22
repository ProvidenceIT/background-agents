-- The session notice outbox: one row per notice a settled session raises,
-- per channel and recipient (control-plane/src/notifications). The unique key
-- makes a repeated projection of the same status revision a no-op, so each
-- recipient hears about a revision once. `payload` is the channel's closed,
-- content-free message (a NoticeEnvelope for Teams): never a title, prompt,
-- agent text, error string or cost. `state` is pending (due for the drainer),
-- shadow (recorded in shadow mode, never sent), sent or failed; error_code is
-- a short code, never a remote response body. The table doubles as the audit
-- of who was told what, where.
CREATE TABLE session_notices (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  channel TEXT NOT NULL,
  recipient_ref TEXT NOT NULL,
  reason_code TEXT,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'shadow', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  claimed_at INTEGER,
  delivered_at INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (session_id, revision, channel, recipient_ref)
);
CREATE INDEX idx_session_notices_due ON session_notices(state, next_attempt_at);
