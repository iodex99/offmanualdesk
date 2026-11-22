-- 0010: which task buttons Desk shows first (console employees.task_role, ADR-061).
ALTER TABLE employees ADD COLUMN task_role TEXT NOT NULL DEFAULT '';
