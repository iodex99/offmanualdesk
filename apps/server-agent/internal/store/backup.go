package store

import (
	"context"
	"fmt"
)

// Backup writes a consistent, compacted copy of the database to dst with
// VACUUM INTO (SQLite 3.27+; works while the service is running). dst must not exist.
func (s *Store) Backup(ctx context.Context, dst string) error {
	_, err := s.db.ExecContext(ctx, `VACUUM INTO ?`, dst)
	return err
}

// IntegrityCheck runs PRAGMA integrity_check and returns an error unless it says "ok".
func (s *Store) IntegrityCheck(ctx context.Context) error {
	var res string
	if err := s.db.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&res); err != nil {
		return err
	}
	if res != "ok" {
		return fmt.Errorf("integrity check: %s", res)
	}
	return nil
}
