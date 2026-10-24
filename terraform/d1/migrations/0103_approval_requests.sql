-- One approval system for every kind of decision a person makes for the factory
-- (control-plane/src/approvals). A request names its responders and choices and
-- settles on the first responder's answer: quorum is kept as a column but fixed
-- at 1. `occurrence_key` makes a repeated create return the existing request.
-- `subject_ref` is canonical JSON (keys sorted, written by the store), so equal
-- subjects compare equal as text; a new request for a subject with a different
-- `digest` (revision or head SHA) supersedes the subject's pending requests.
-- Nothing waits on a request: the handler for its kind starts the follow-up
-- when it is decided. JSON columns are validated by the store's schemas.
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'memory', 'provider_account', 'propose_fix', 'merge', 'readiness_override',
    'issue_publication', 'plan', 'session_request'
  )),
  subject_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  recommendation TEXT CHECK (recommendation IN ('approve', 'reject', 'send_back')),
  -- JSON array of 'approve' | 'reject' | 'send_back'
  choices TEXT NOT NULL,
  -- Members of this team may answer, narrowed to `responder_role` when set;
  -- named users are in approval_request_responders.
  responder_team_id TEXT,
  responder_role TEXT CHECK (responder_role IN ('lead', 'member')),
  quorum INTEGER NOT NULL DEFAULT 1 CHECK (quorum = 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'rejected', 'sent_back', 'expired', 'superseded'
  )),
  digest TEXT,
  occurrence_key TEXT NOT NULL UNIQUE,
  expires_at INTEGER,
  -- The creating principal: `service:<name>` for a trusted service.
  created_by TEXT NOT NULL,
  follow_up TEXT,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (responder_role IS NULL OR responder_team_id IS NOT NULL)
);
CREATE INDEX idx_approval_requests_subject ON approval_requests(kind, subject_ref, status);
CREATE INDEX idx_approval_requests_expiry ON approval_requests(status, expires_at);
CREATE INDEX idx_approval_requests_team ON approval_requests(responder_team_id, status);

-- Users named as responders of a request.
CREATE TABLE approval_request_responders (
  request_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  PRIMARY KEY (request_id, user_id)
);
CREATE INDEX idx_approval_request_responders_user ON approval_request_responders(user_id, request_id);

-- One row per recorded answer. With quorum 1 a request has at most one; the
-- unique pair keeps one answer per person when quorum is raised.
CREATE TABLE approval_decisions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'send_back')),
  note TEXT,
  surface TEXT NOT NULL CHECK (surface IN ('teams', 'web', 'api')),
  decided_at INTEGER NOT NULL,
  UNIQUE (request_id, user_id)
);
