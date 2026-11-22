-- 0009: Request access after an Access Denied (PRODUCT ease rule 6, ADR-058). Stays on the
-- firm's server: the target is a path and never goes to the console.
CREATE TABLE access_requests (
  id          INTEGER PRIMARY KEY,
  sid         TEXT NOT NULL,
  audit_id    INTEGER NOT NULL UNIQUE,
  target      TEXT NOT NULL,
  note        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  resolved_by TEXT,
  resolved_at INTEGER
) STRICT;
CREATE INDEX access_requests_status ON access_requests (status, created_at);
