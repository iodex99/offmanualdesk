-- 0007: employees who are also firm admins (console policy `admin`), for admin-only notices (ADR-052).
ALTER TABLE employees ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
