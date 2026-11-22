package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Employee is a row of `employees`. Secrets are opaque blobs/hashes here; the auth
// package interprets them.
type Employee struct {
	SID             string
	EmployeeID      string
	Name            string
	Status          string // invited | active | disabled
	Packs           []string
	TOTPSecretDPAPI []byte
	TOTPLastCounter uint64
	PINHash         string
}

// UpsertEmployee inserts or replaces the policy-owned fields of an employee
// (from console policy sync). Secrets and counters are left untouched.
func (s *Store) UpsertEmployee(ctx context.Context, e Employee) error {
	packs, err := json.Marshal(nonNil(e.Packs))
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO employees (sid, employee_id, name, status, packs, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (sid) DO UPDATE SET employee_id = excluded.employee_id, name = excluded.name,
			status = excluded.status, packs = excluded.packs, updated_at = excluded.updated_at`,
		e.SID, e.EmployeeID, e.Name, e.Status, string(packs), s.now().Unix())
	return err
}

// Employee loads one employee by SID.
func (s *Store) Employee(ctx context.Context, sid string) (Employee, error) {
	var e Employee
	var packs string
	var pin sql.NullString
	var counter int64
	err := s.db.QueryRowContext(ctx, `SELECT sid, employee_id, name, status, packs, totp_secret_dpapi,
		totp_last_counter, pin_hash FROM employees WHERE sid = ?`, sid).
		Scan(&e.SID, &e.EmployeeID, &e.Name, &e.Status, &packs, &e.TOTPSecretDPAPI, &counter, &pin)
	if errors.Is(err, sql.ErrNoRows) {
		return Employee{}, ErrNotFound
	}
	if err != nil {
		return Employee{}, err
	}
	if err := json.Unmarshal([]byte(packs), &e.Packs); err != nil {
		return Employee{}, fmt.Errorf("employee %s packs: %w", sid, err)
	}
	e.TOTPLastCounter = uint64(counter) //nolint:gosec // stored from uint64, never negative
	e.PINHash = pin.String
	return e, nil
}

// SetTOTPSecret stores the DPAPI-protected TOTP secret and resets replay state.
func (s *Store) SetTOTPSecret(ctx context.Context, sid string, protected []byte) error {
	return s.exec1(ctx, `UPDATE employees SET totp_secret_dpapi = ?, totp_last_counter = 0, updated_at = ? WHERE sid = ?`,
		protected, s.now().Unix(), sid)
}

// AdvanceTOTPCounter records an accepted TOTP step. It only moves forward, so a
// concurrent older code can't roll replay protection back.
func (s *Store) AdvanceTOTPCounter(ctx context.Context, sid string, counter uint64) error {
	if counter > 1<<62 {
		return errors.New("counter out of range")
	}
	return s.exec1(ctx, `UPDATE employees SET totp_last_counter = MAX(totp_last_counter, ?) WHERE sid = ?`,
		int64(counter), sid) //nolint:gosec // bounded above
}

// SetPINHash stores a PIN hash.
func (s *Store) SetPINHash(ctx context.Context, sid, hash string) error {
	return s.exec1(ctx, `UPDATE employees SET pin_hash = ?, updated_at = ? WHERE sid = ?`, hash, s.now().Unix(), sid)
}

// ---- day grants ----

// GrantDay records a daily unlock valid until expires.
func (s *Store) GrantDay(ctx context.Context, sid string, expires time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO day_grants (sid, granted_at, expires_at) VALUES (?, ?, ?)
		ON CONFLICT (sid) DO UPDATE SET granted_at = excluded.granted_at, expires_at = excluded.expires_at`,
		sid, s.now().Unix(), expires.Unix())
	return err
}

// DayGrantValid reports whether the employee has an unexpired day grant.
func (s *Store) DayGrantValid(ctx context.Context, sid string) (bool, error) {
	var exp int64
	err := s.db.QueryRowContext(ctx, `SELECT expires_at FROM day_grants WHERE sid = ?`, sid).Scan(&exp)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil && s.now().Unix() < exp, err
}

// RevokeDay ends the day grant (offboarding, admin action, lockout).
func (s *Store) RevokeDay(ctx context.Context, sid string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM day_grants WHERE sid = ?`, sid)
	return err
}

// ---- lock state ----

// LockState mirrors `lock_state`.
type LockState struct {
	DeskLocked            bool
	TelegramUnlockedUntil time.Time
	FailedPINs            int
	FailedCodes           int
	LockoutUntil          time.Time
}

// Lock loads lock state; a missing row means locked with no failures.
func (s *Store) Lock(ctx context.Context, sid string) (LockState, error) {
	var l LockState
	var locked int
	var tg, lockout int64
	err := s.db.QueryRowContext(ctx, `SELECT desk_locked, telegram_unlocked_until, failed_pins, failed_codes, lockout_until
		FROM lock_state WHERE sid = ?`, sid).Scan(&locked, &tg, &l.FailedPINs, &l.FailedCodes, &lockout)
	if errors.Is(err, sql.ErrNoRows) {
		return LockState{DeskLocked: true}, nil
	}
	if err != nil {
		return LockState{}, err
	}
	l.DeskLocked = locked != 0
	l.TelegramUnlockedUntil = unixOrZero(tg)
	l.LockoutUntil = unixOrZero(lockout)
	return l, nil
}

// SaveLock writes lock state.
func (s *Store) SaveLock(ctx context.Context, sid string, l LockState) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO lock_state (sid, desk_locked, telegram_unlocked_until, failed_pins, failed_codes, lockout_until)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (sid) DO UPDATE SET desk_locked = excluded.desk_locked,
			telegram_unlocked_until = excluded.telegram_unlocked_until, failed_pins = excluded.failed_pins,
			failed_codes = excluded.failed_codes, lockout_until = excluded.lockout_until`,
		sid, boolInt(l.DeskLocked), timeUnix(l.TelegramUnlockedUntil), l.FailedPINs, l.FailedCodes, timeUnix(l.LockoutUntil))
	return err
}

// ---- audit ----

// AuditEvent is one local audit row. Target may hold a path: it never leaves the server.
type AuditEvent struct {
	SID, Category, Action, Target, Result, CorrelationID string
}

// AppendAudit adds an audit row.
func (s *Store) AppendAudit(ctx context.Context, e AuditEvent) error {
	if e.SID == "" || e.Category == "" || e.Action == "" || e.Result == "" {
		return errors.New("audit event needs sid, category, action and result")
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO audit (ts, sid, category, action, target, result, correlation_id)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, s.now().Unix(), e.SID, e.Category, e.Action, e.Target, e.Result, e.CorrelationID)
	return err
}

// AuditCount is one row of the console-bound summary: counts only, no targets.
type AuditCount struct {
	Category string `json:"category"`
	Count    int    `json:"count"`
}

// AuditSummary counts events by category in [from, to). Paths never appear here.
func (s *Store) AuditSummary(ctx context.Context, from, to time.Time) ([]AuditCount, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT category, COUNT(*) FROM audit WHERE ts >= ? AND ts < ?
		GROUP BY category ORDER BY category`, from.Unix(), to.Unix())
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []AuditCount
	for rows.Next() {
		var c AuditCount
		if err := rows.Scan(&c.Category, &c.Count); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ---- helpers ----

func (s *Store) exec1(ctx context.Context, q string, args ...any) error {
	res, err := s.db.ExecContext(ctx, q, args...)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func timeUnix(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.Unix()
}

func unixOrZero(v int64) time.Time {
	if v == 0 {
		return time.Time{}
	}
	return time.Unix(v, 0)
}
