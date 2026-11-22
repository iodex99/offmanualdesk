package store

import "context"

// SetRunningVersion records the release the employee's gateway runs (ADR-063).
func (s *Store) SetRunningVersion(ctx context.Context, sid, version string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE employees SET running_version = ? WHERE sid = ?`, version, sid)
	return err
}

// EmployeeVersion is one employee's reported release.
type EmployeeVersion struct {
	EmployeeID string
	Version    string
}

// RunningVersions lists active employees with a reported release.
func (s *Store) RunningVersions(ctx context.Context) ([]EmployeeVersion, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT employee_id, running_version FROM employees
		WHERE status = 'active' AND running_version <> '' ORDER BY employee_id LIMIT 1000`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []EmployeeVersion
	for rows.Next() {
		var v EmployeeVersion
		if err := rows.Scan(&v.EmployeeID, &v.Version); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
