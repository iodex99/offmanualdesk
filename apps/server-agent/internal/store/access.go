package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// Request access (ADR-058). Denials come from the guard's local audit rows
// (category access_denied, target = the path the tool tried); the request copies the
// target from that row, never from what the caller sends.

// ErrAlreadyRequested means the denial already has a request.
var ErrAlreadyRequested = errors.New("access already requested")

// ErrTooManyRequests means the employee has too many open requests.
var ErrTooManyRequests = errors.New("too many open access requests")

// MaxOpenAccessRequests per employee.
const MaxOpenAccessRequests = 20

// Denial is one Access Denied seen by the guard for an employee.
type Denial struct {
	ID        int64
	At        time.Time
	Target    string
	Requested bool
}

// AccessRequest is a note to the firm's admins.
type AccessRequest struct {
	ID         int64
	SID        string
	Name       string
	Target     string
	Note       string
	CreatedAt  time.Time
	Status     string // open | done | declined
	ResolvedAt time.Time
}

// RecentDenials lists the employee's denials since the given time, newest first (≤ 10).
func (s *Store) RecentDenials(ctx context.Context, sid string, since time.Time) ([]Denial, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT a.id, a.ts, a.target, r.id IS NOT NULL
		FROM audit a LEFT JOIN access_requests r ON r.audit_id = a.id
		WHERE a.sid = ? AND a.category = 'access_denied' AND a.ts >= ?
		ORDER BY a.id DESC LIMIT 10`, sid, since.Unix())
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Denial
	for rows.Next() {
		var d Denial
		var ts int64
		if err := rows.Scan(&d.ID, &ts, &d.Target, &d.Requested); err != nil {
			return nil, err
		}
		d.At = time.Unix(ts, 0)
		out = append(out, d)
	}
	return out, rows.Err()
}

// CreateAccessRequest turns one of the employee's own denials into a request.
func (s *Store) CreateAccessRequest(ctx context.Context, sid string, auditID int64, note string) (int64, error) {
	var id int64
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		var target string
		err := tx.QueryRowContext(ctx, `SELECT target FROM audit WHERE id = ? AND sid = ? AND category = 'access_denied'`,
			auditID, sid).Scan(&target)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		var dup, open int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM access_requests WHERE audit_id = ?`, auditID).Scan(&dup); err != nil {
			return err
		}
		if dup > 0 {
			return ErrAlreadyRequested
		}
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM access_requests WHERE sid = ? AND status = 'open'`, sid).Scan(&open); err != nil {
			return err
		}
		if open >= MaxOpenAccessRequests {
			return ErrTooManyRequests
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO access_requests (sid, audit_id, target, note, created_at) VALUES (?, ?, ?, ?, ?)`,
			sid, auditID, target, note, s.now().Unix())
		if err != nil {
			return err
		}
		id, err = res.LastInsertId()
		return err
	})
	return id, err
}

// AccessRequests lists open requests and those resolved in the last 7 days; all
// employees' when all is true (admins), else only sid's.
func (s *Store) AccessRequests(ctx context.Context, sid string, all bool) ([]AccessRequest, error) {
	q := `SELECT r.id, r.sid, COALESCE(e.name, ''), r.target, r.note, r.created_at, r.status, COALESCE(r.resolved_at, 0)
		FROM access_requests r LEFT JOIN employees e ON e.sid = r.sid
		WHERE (r.status = 'open' OR r.resolved_at >= ?) AND (? OR r.sid = ?)
		ORDER BY r.status <> 'open', r.id DESC LIMIT 100`
	rows, err := s.db.QueryContext(ctx, q, s.now().Add(-7*24*time.Hour).Unix(), all, sid)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []AccessRequest
	for rows.Next() {
		var r AccessRequest
		var created, resolved int64
		if err := rows.Scan(&r.ID, &r.SID, &r.Name, &r.Target, &r.Note, &created, &r.Status, &resolved); err != nil {
			return nil, err
		}
		r.CreatedAt = time.Unix(created, 0)
		if resolved > 0 {
			r.ResolvedAt = time.Unix(resolved, 0)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ResolveAccessRequest marks an open request done or declined.
func (s *Store) ResolveAccessRequest(ctx context.Context, id int64, by, status string) error {
	if status != "done" && status != "declined" {
		return errors.New("status must be done or declined")
	}
	res, err := s.db.ExecContext(ctx, `UPDATE access_requests SET status = ?, resolved_by = ?, resolved_at = ?
		WHERE id = ? AND status = 'open'`, status, by, s.now().Unix(), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// IsAdmin reports whether the employee is also a firm admin (console policy, ADR-052).
func (s *Store) IsAdmin(ctx context.Context, sid string) (bool, error) {
	var v int
	err := s.db.QueryRowContext(ctx, `SELECT is_admin FROM employees WHERE sid = ?`, sid).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return v == 1, err
}
