-- 0004: release severity and security deadline for staged versions (UPDATES.md §4, ADR-048).
ALTER TABLE updates ADD COLUMN severity TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE updates ADD COLUMN deadline_at INTEGER NOT NULL DEFAULT 0;
