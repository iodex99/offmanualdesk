package store

import (
	"context"
	"time"
)

// ApplyTOTPReset clears an employee's authenticator, recovery codes and day grant
// when requestedAt is newer than the last reset applied (ADR-049). Reports whether
// it reset anything. Idempotent: the same request is applied once.
func (s *Store) ApplyTOTPReset(ctx context.Context, sid string, requestedAt time.Time) (bool, error) {
	if requestedAt.IsZero() {
		return false, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx, `UPDATE employees SET totp_secret_dpapi = NULL, totp_enrolled_at = 0,
		totp_last_counter = 0, recovery_codes_hash = NULL, totp_reset_applied_at = ?, updated_at = ?
		WHERE sid = ? AND totp_reset_applied_at < ?`, requestedAt.Unix(), s.now().Unix(), sid, requestedAt.Unix())
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil || n == 0 {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM day_grants WHERE sid = ?`, sid); err != nil {
		return false, err
	}
	return true, tx.Commit()
}
