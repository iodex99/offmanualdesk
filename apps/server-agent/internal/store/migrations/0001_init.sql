-- Server Agent local store, schema v1 (docs/DATA_MODEL.md §2).
-- Times are Unix seconds (UTC). Nothing here is ever sent to the console as-is:
-- `audit.target` may hold paths and stays on the firm's server (SECURITY.md §4).

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE employees (
  sid                 TEXT PRIMARY KEY,
  employee_id         TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
  packs               TEXT NOT NULL DEFAULT '[]',
  totp_secret_dpapi   BLOB,
  totp_last_counter   INTEGER NOT NULL DEFAULT 0,
  pin_hash            TEXT,
  recovery_codes_hash TEXT,
  updated_at          INTEGER NOT NULL
) STRICT;

CREATE TABLE day_grants (
  sid        TEXT PRIMARY KEY REFERENCES employees (sid) ON DELETE CASCADE,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE lock_state (
  sid                     TEXT PRIMARY KEY REFERENCES employees (sid) ON DELETE CASCADE,
  desk_locked             INTEGER NOT NULL DEFAULT 1,
  telegram_unlocked_until INTEGER NOT NULL DEFAULT 0,
  failed_pins             INTEGER NOT NULL DEFAULT 0,
  failed_codes            INTEGER NOT NULL DEFAULT 0,
  lockout_until           INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE leases (
  sid          TEXT PRIMARY KEY,
  port         INTEGER NOT NULL UNIQUE,
  token_hash   TEXT NOT NULL,
  pid          INTEGER NOT NULL DEFAULT 0,
  started_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
) STRICT;

CREATE TABLE telegram_links (
  sid              TEXT PRIMARY KEY REFERENCES employees (sid) ON DELETE CASCADE,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  linked_at        INTEGER NOT NULL
) STRICT;

CREATE TABLE telegram_link_codes (
  code_hash  TEXT PRIMARY KEY,
  sid        TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
) STRICT;

CREATE TABLE audit (
  id             INTEGER PRIMARY KEY,
  ts             INTEGER NOT NULL,
  sid            TEXT NOT NULL,
  category       TEXT NOT NULL,
  action         TEXT NOT NULL,
  target         TEXT NOT NULL DEFAULT '',
  result         TEXT NOT NULL,
  correlation_id TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX audit_ts ON audit (ts);

CREATE TABLE usage (
  date            TEXT NOT NULL,
  sid             TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  turns           INTEGER NOT NULL DEFAULT 0,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, sid)
) STRICT;

CREATE TABLE notices (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('update', 'billing', 'admin')),
  audience   TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE notice_acks (
  notice_id TEXT NOT NULL REFERENCES notices (id) ON DELETE CASCADE,
  sid       TEXT NOT NULL,
  acked_at  INTEGER NOT NULL,
  PRIMARY KEY (notice_id, sid)
) STRICT;

CREATE TABLE updates (
  version     TEXT PRIMARY KEY,
  state       TEXT NOT NULL CHECK (state IN ('available', 'downloading', 'staged', 'failed', 'active')),
  verified_at INTEGER,
  error       TEXT
) STRICT;
