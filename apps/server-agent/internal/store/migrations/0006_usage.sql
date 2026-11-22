-- 0006: per-employee daily usage counts from the guard (ADR-051). Counts only, never text.
CREATE TABLE usage_daily (
  sid           TEXT NOT NULL,
  date          TEXT NOT NULL, -- YYYY-MM-DD, IST
  turns         INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sid, date)
);
