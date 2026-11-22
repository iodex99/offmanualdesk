package store

import "context"

// UsageRow is one employee's usage on one day.
type UsageRow struct {
	SID          string
	EmployeeID   string
	Turns        int64
	InputTokens  int64
	OutputTokens int64
}

// AddUsage adds counts to sid's day (YYYY-MM-DD, IST).
func (s *Store) AddUsage(ctx context.Context, sid, date string, turns, in, out int64) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO usage_daily (sid, date, turns, input_tokens, output_tokens)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (sid, date) DO UPDATE SET turns = turns + excluded.turns,
			input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
		sid, date, turns, in, out)
	return err
}

// UsageForDate returns every employee's usage on a day, with their console employee ID.
func (s *Store) UsageForDate(ctx context.Context, date string) ([]UsageRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT u.sid, e.employee_id, u.turns, u.input_tokens, u.output_tokens
		FROM usage_daily u JOIN employees e ON e.sid = u.sid WHERE u.date = ? ORDER BY u.sid`, date)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []UsageRow
	for rows.Next() {
		var r UsageRow
		if err := rows.Scan(&r.SID, &r.EmployeeID, &r.Turns, &r.InputTokens, &r.OutputTokens); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
