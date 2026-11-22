package store

import (
	"context"
	"database/sql"
	"errors"
)

// TaskRoles Desk knows (SKILLS.md §5, ADR-061); anything else is stored as "".
var TaskRoles = map[string]bool{"article": true, "senior": true, "manager": true, "partner": true}

// SetEmployeeTaskRole records which task buttons the employee sees first.
func (s *Store) SetEmployeeTaskRole(ctx context.Context, sid, role string) error {
	if !TaskRoles[role] {
		role = ""
	}
	_, err := s.db.ExecContext(ctx, `UPDATE employees SET task_role = ? WHERE sid = ?`, role, sid)
	return err
}

// EmployeeTaskRole returns the employee's task role ("" when none).
func (s *Store) EmployeeTaskRole(ctx context.Context, sid string) (string, error) {
	var r string
	err := s.db.QueryRowContext(ctx, `SELECT task_role FROM employees WHERE sid = ?`, sid).Scan(&r)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return r, err
}
