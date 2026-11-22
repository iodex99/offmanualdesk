-- 0008: offboarding archive cycles (F10, ADR-056). One open cycle per SID (cancelled_at NULL);
-- re-enabling cancels it, a later disable starts a new one. Archives are purged after the
-- firm's retention whether or not the cycle was cancelled.
CREATE TABLE offboarding (
  id INTEGER PRIMARY KEY,
  sid TEXT NOT NULL,
  disabled_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  archive_name TEXT,
  archived_at INTEGER,
  cleaned_at INTEGER,
  purged_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX offboarding_sid ON offboarding (sid);
