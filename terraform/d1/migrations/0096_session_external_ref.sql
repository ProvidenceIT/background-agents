-- Caller-supplied idempotency key for POST /sessions, unique per calling
-- service. external_ref_service is the verified sig1 service name (never
-- 'web' or a person). The three columns are NULL together or set together;
-- releasing a ref (a failed or orphaned first attempt) clears all three.
-- external_ref_fingerprint is 'v1:' || sha256 of the canonical request body.
ALTER TABLE sessions ADD COLUMN external_ref_service TEXT;
ALTER TABLE sessions ADD COLUMN external_ref TEXT;
ALTER TABLE sessions ADD COLUMN external_ref_fingerprint TEXT;
CREATE UNIQUE INDEX idx_sessions_external_ref
  ON sessions(external_ref_service, external_ref)
  WHERE external_ref IS NOT NULL;
