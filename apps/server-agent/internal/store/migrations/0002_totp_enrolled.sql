-- TOTP enrolment is two steps (ADR-006 / F2): start stores an unconfirmed secret,
-- confirm (a correct code) sets totp_enrolled_at. Unconfirmed secrets never unlock.
ALTER TABLE employees ADD COLUMN totp_enrolled_at INTEGER NOT NULL DEFAULT 0;
