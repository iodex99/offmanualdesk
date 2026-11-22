package store

import (
	"context"
	"database/sql"
	"time"
)

// Offboarding is one archive cycle for a switched-off employee (F10, ADR-056).
type Offboarding struct {
	ID          int64
	SID         string
	DisabledAt  time.Time
	ArchiveName string // "" when there was nothing to archive
	ArchivedAt  time.Time
	Attempts    int
}

// startOffboarding opens a cycle unless the SID already has one that isn't cancelled.
func startOffboarding(ctx context.Context, tx *sql.Tx, sid string, now time.Time) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO offboarding (sid, disabled_at)
		SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM offboarding WHERE sid = ? AND cancelled_at IS NULL)`,
		sid, now.Unix(), sid)
	return err
}

// CancelOffboarding is called when an employee is active again: an open cycle stops
// (its archive, if made, is still purged after the retention period).
func (s *Store) CancelOffboarding(ctx context.Context, sid string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE offboarding SET cancelled_at = ? WHERE sid = ? AND cancelled_at IS NULL`,
		s.now().Unix(), sid)
	return err
}

// OffboardingDue lists open cycles not archived yet whose employee was switched off
// at least grace ago and is still not active.
func (s *Store) OffboardingDue(ctx context.Context, grace time.Duration) ([]Offboarding, error) {
	return s.offboardingRows(ctx, `SELECT o.id, o.sid, o.disabled_at, COALESCE(o.archive_name, ''), COALESCE(o.archived_at, 0), o.attempts
		FROM offboarding o LEFT JOIN employees e ON e.sid = o.sid
		WHERE o.cancelled_at IS NULL AND o.archived_at IS NULL AND o.disabled_at <= ?
		AND COALESCE(e.status, 'disabled') <> 'active' ORDER BY o.id`, s.now().Add(-grace).Unix())
}

// OffboardingCleanupDue lists archived open cycles whose originals are not removed yet.
func (s *Store) OffboardingCleanupDue(ctx context.Context) ([]Offboarding, error) {
	return s.offboardingRows(ctx, `SELECT o.id, o.sid, o.disabled_at, COALESCE(o.archive_name, ''), o.archived_at, o.attempts
		FROM offboarding o LEFT JOIN employees e ON e.sid = o.sid
		WHERE o.cancelled_at IS NULL AND o.archived_at IS NOT NULL AND o.cleaned_at IS NULL
		AND COALESCE(e.status, 'disabled') <> 'active' ORDER BY o.id`)
}

// OffboardingPurgeDue lists archives older than the retention period, not purged yet.
func (s *Store) OffboardingPurgeDue(ctx context.Context, retention time.Duration) ([]Offboarding, error) {
	return s.offboardingRows(ctx, `SELECT id, sid, disabled_at, COALESCE(archive_name, ''), archived_at, attempts
		FROM offboarding WHERE archived_at IS NOT NULL AND purged_at IS NULL AND archived_at <= ? ORDER BY id`,
		s.now().Add(-retention).Unix())
}

func (s *Store) offboardingRows(ctx context.Context, q string, args ...any) ([]Offboarding, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Offboarding
	for rows.Next() {
		var o Offboarding
		var disabled, archived int64
		if err := rows.Scan(&o.ID, &o.SID, &disabled, &o.ArchiveName, &archived, &o.Attempts); err != nil {
			return nil, err
		}
		o.DisabledAt = time.Unix(disabled, 0)
		if archived > 0 {
			o.ArchivedAt = time.Unix(archived, 0)
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// OffboardingArchived records the archive ("" when there was nothing to keep).
func (s *Store) OffboardingArchived(ctx context.Context, id int64, name string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE offboarding SET archive_name = ?, archived_at = ?, last_error = NULL WHERE id = ?`,
		name, s.now().Unix(), id)
	return err
}

// OffboardingCleaned records that the originals in the profile are gone.
func (s *Store) OffboardingCleaned(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE offboarding SET cleaned_at = ?, last_error = NULL WHERE id = ?`, s.now().Unix(), id)
	return err
}

// OffboardingPurged records that the archive was deleted after the retention period.
func (s *Store) OffboardingPurged(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE offboarding SET purged_at = ? WHERE id = ?`, s.now().Unix(), id)
	return err
}

// OffboardingFailed counts a failed attempt with a short reason (no file names).
func (s *Store) OffboardingFailed(ctx context.Context, id int64, reason string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE offboarding SET attempts = attempts + 1, last_error = ? WHERE id = ?`, reason, id)
	return err
}
