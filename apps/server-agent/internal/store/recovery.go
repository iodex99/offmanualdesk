package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// SetRecoveryCodes replaces an employee's recovery-code hashes (shown once, F2 step 4).
func (s *Store) SetRecoveryCodes(ctx context.Context, sid string, hashes []string) error {
	b, err := json.Marshal(nonNil(hashes))
	if err != nil {
		return err
	}
	return s.exec1(ctx, `UPDATE employees SET recovery_codes_hash = ?, updated_at = ? WHERE sid = ?`, string(b), s.now().Unix(), sid)
}

// RecoveryCodesLeft counts unused recovery codes.
func (s *Store) RecoveryCodesLeft(ctx context.Context, sid string) (int, error) {
	var raw sql.NullString
	if err := s.db.QueryRowContext(ctx, `SELECT recovery_codes_hash FROM employees WHERE sid = ?`, sid).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, ErrNotFound
		}
		return 0, err
	}
	var hashes []string
	if raw.Valid && raw.String != "" {
		if err := json.Unmarshal([]byte(raw.String), &hashes); err != nil {
			return 0, err
		}
	}
	return len(hashes), nil
}

// UseRecoveryCode consumes one recovery code (by hash) and resets the TOTP enrolment
// so the employee enrols a new phone. Atomic: a code works once.
func (s *Store) UseRecoveryCode(ctx context.Context, sid, hash string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	var raw sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT recovery_codes_hash FROM employees WHERE sid = ?`, sid).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, ErrNotFound
		}
		return false, err
	}
	var hashes []string
	if raw.Valid && raw.String != "" {
		if err := json.Unmarshal([]byte(raw.String), &hashes); err != nil {
			return false, err
		}
	}
	kept := hashes[:0]
	found := false
	for _, h := range hashes {
		if !found && h == hash {
			found = true
			continue
		}
		kept = append(kept, h)
	}
	if !found {
		return false, nil
	}
	b, err := json.Marshal(nonNil(kept))
	if err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE employees SET recovery_codes_hash = ?, totp_secret_dpapi = NULL,
		totp_enrolled_at = 0, totp_last_counter = 0, updated_at = ? WHERE sid = ?`, string(b), s.now().Unix(), sid); err != nil {
		return false, err
	}
	return true, tx.Commit()
}
