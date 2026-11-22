-- 0011: the release each employee's gateway runs, reported by Desk (UPDATES §4, ADR-063).
ALTER TABLE employees ADD COLUMN running_version TEXT NOT NULL DEFAULT '';
