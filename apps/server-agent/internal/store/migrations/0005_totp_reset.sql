-- 0005: admin-requested authenticator resets from the console policy (ADR-049).
-- The newest reset request applied for this employee (unix seconds); a request is applied once.
ALTER TABLE employees ADD COLUMN totp_reset_applied_at INTEGER NOT NULL DEFAULT 0;
