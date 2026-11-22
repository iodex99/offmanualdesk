package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// StagedRelease is the newest verified release waiting for Desks to switch to it.
type StagedRelease struct {
	Version  string
	Severity string    // normal | security
	Deadline time.Time // zero when none
}

// SetUpdateMeta records a release's severity and security deadline (no-op for an
// unknown version).
func (s *Store) SetUpdateMeta(ctx context.Context, version, severity string, deadline time.Time) error {
	if severity != "security" {
		severity = "normal"
	}
	var d int64
	if !deadline.IsZero() {
		d = deadline.Unix()
	}
	_, err := s.db.ExecContext(ctx, `UPDATE updates SET severity = ?, deadline_at = ? WHERE version = ?`, severity, d, version)
	return err
}

// StagedRelease returns the newest staged release (zero value when none).
func (s *Store) StagedRelease(ctx context.Context) (StagedRelease, error) {
	var r StagedRelease
	var d int64
	err := s.db.QueryRowContext(ctx, `SELECT version, severity, deadline_at FROM updates WHERE state = 'staged'
		ORDER BY verified_at DESC LIMIT 1`).Scan(&r.Version, &r.Severity, &d)
	if errors.Is(err, sql.ErrNoRows) {
		return StagedRelease{}, nil
	}
	r.Deadline = unixOrZero(d)
	return r, err
}
