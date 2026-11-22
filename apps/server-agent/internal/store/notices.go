package store

import (
	"context"
	"time"
)

// Notice is a message from the console for Desk (ADR-052).
type Notice struct {
	ID       string
	Kind     string // update | billing | admin
	Audience string // all | admins
	Title    string
	Body     string
	Created  time.Time
}

// SetEmployeeAdmin records whether the employee is also a firm admin.
func (s *Store) SetEmployeeAdmin(ctx context.Context, sid string, admin bool) error {
	v := 0
	if admin {
		v = 1
	}
	_, err := s.db.ExecContext(ctx, `UPDATE employees SET is_admin = ? WHERE sid = ?`, v, sid)
	return err
}

// ReplaceNotices makes the local notices exactly the console's active list; dismissals
// of notices that are still active are kept.
func (s *Store) ReplaceNotices(ctx context.Context, list []Notice) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	keep := map[string]bool{}
	for _, n := range list {
		keep[n.ID] = true
		if _, err := tx.ExecContext(ctx, `INSERT INTO notices (id, kind, audience, title, body, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, audience = excluded.audience,
				title = excluded.title, body = excluded.body`,
			n.ID, n.Kind, n.Audience, n.Title, n.Body, n.Created.Unix()); err != nil {
			return err
		}
	}
	rows, err := tx.QueryContext(ctx, `SELECT id FROM notices`)
	if err != nil {
		return err
	}
	var gone []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return err
		}
		if !keep[id] {
			gone = append(gone, id)
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, id := range gone {
		if _, err := tx.ExecContext(ctx, `DELETE FROM notice_acks WHERE notice_id = ?`, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM notices WHERE id = ?`, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// NoticesFor lists the notices an employee hasn't dismissed; admin-only notices
// only for employees who are firm admins.
func (s *Store) NoticesFor(ctx context.Context, sid string) ([]Notice, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT n.id, n.kind, n.audience, n.title, n.body, n.created_at
		FROM notices n JOIN employees e ON e.sid = ?
		WHERE (n.audience = 'all' OR (n.audience = 'admins' AND e.is_admin = 1))
		  AND NOT EXISTS (SELECT 1 FROM notice_acks a WHERE a.notice_id = n.id AND a.sid = ?)
		ORDER BY n.created_at`, sid, sid)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Notice
	for rows.Next() {
		var n Notice
		var created int64
		if err := rows.Scan(&n.ID, &n.Kind, &n.Audience, &n.Title, &n.Body, &created); err != nil {
			return nil, err
		}
		n.Created = time.Unix(created, 0)
		out = append(out, n)
	}
	return out, rows.Err()
}

// AckNotice records that sid dismissed a notice (no-op for unknown notices).
func (s *Store) AckNotice(ctx context.Context, id, sid string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO notice_acks (notice_id, sid, acked_at)
		SELECT id, ?, ? FROM notices WHERE id = ? ON CONFLICT (notice_id, sid) DO NOTHING`, sid, s.now().Unix(), id)
	return err
}
