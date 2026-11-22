package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrNoFreePort means every port in the gateway range is leased.
var ErrNoFreePort = errors.New("no free gateway port")

// Lease mirrors a `leases` row. Only the token's hash is stored.
type Lease struct {
	SID        string
	Port       int
	TokenHash  string
	PID        int
	StartedAt  time.Time
	LastSeenAt time.Time
}

// AcquireLease gives sid a port in [minPort, maxPort], reusing the employee's
// previous port when it still holds a lease (stable ports, ARCHITECTURE §4), and
// replaces the token hash. Allocation and insert run in one transaction.
func (s *Store) AcquireLease(ctx context.Context, sid string, minPort, maxPort int, tokenHash string) (Lease, error) {
	if minPort <= 0 || maxPort < minPort || maxPort > 65535 {
		return Lease{}, fmt.Errorf("bad port range %d-%d", minPort, maxPort)
	}
	now := s.now().Unix()
	var out Lease
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		var port int
		err := tx.QueryRowContext(ctx, `SELECT port FROM leases WHERE sid = ?`, sid).Scan(&port)
		switch {
		case err == nil && port >= minPort && port <= maxPort:
			_, err = tx.ExecContext(ctx, `UPDATE leases SET token_hash = ?, pid = 0, started_at = ?, last_seen_at = ? WHERE sid = ?`,
				tokenHash, now, now, sid)
			if err != nil {
				return err
			}
		case err == nil || errors.Is(err, sql.ErrNoRows):
			if _, err := tx.ExecContext(ctx, `DELETE FROM leases WHERE sid = ?`, sid); err != nil {
				return err
			}
			port, err = lowestFreePort(ctx, tx, minPort, maxPort)
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO leases (sid, port, token_hash, pid, started_at, last_seen_at)
				VALUES (?, ?, ?, 0, ?, ?)`, sid, port, tokenHash, now, now); err != nil {
				return err
			}
		default:
			return err
		}
		out = Lease{SID: sid, Port: port, TokenHash: tokenHash, StartedAt: time.Unix(now, 0), LastSeenAt: time.Unix(now, 0)}
		return nil
	})
	return out, err
}

func lowestFreePort(ctx context.Context, tx *sql.Tx, minPort, maxPort int) (int, error) {
	rows, err := tx.QueryContext(ctx, `SELECT port FROM leases WHERE port BETWEEN ? AND ? ORDER BY port`, minPort, maxPort)
	if err != nil {
		return 0, err
	}
	defer func() { _ = rows.Close() }()
	want := minPort
	for rows.Next() {
		var p int
		if err := rows.Scan(&p); err != nil {
			return 0, err
		}
		if p > want {
			break
		}
		want = p + 1
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if want > maxPort {
		return 0, ErrNoFreePort
	}
	return want, nil
}

// LeaseFor returns sid's lease or ErrNotFound.
func (s *Store) LeaseFor(ctx context.Context, sid string) (Lease, error) {
	var l Lease
	var started, seen int64
	err := s.db.QueryRowContext(ctx, `SELECT sid, port, token_hash, pid, started_at, last_seen_at FROM leases WHERE sid = ?`, sid).
		Scan(&l.SID, &l.Port, &l.TokenHash, &l.PID, &started, &seen)
	if errors.Is(err, sql.ErrNoRows) {
		return Lease{}, ErrNotFound
	}
	l.StartedAt, l.LastSeenAt = time.Unix(started, 0), time.Unix(seen, 0)
	return l, err
}

// TouchLease records the gateway PID and a heartbeat.
func (s *Store) TouchLease(ctx context.Context, sid string, pid int) error {
	return s.exec1(ctx, `UPDATE leases SET pid = ?, last_seen_at = ? WHERE sid = ?`, pid, s.now().Unix(), sid)
}

// ReleaseLease frees sid's port.
func (s *Store) ReleaseLease(ctx context.Context, sid string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM leases WHERE sid = ?`, sid)
	return err
}

// ExpireLeases frees leases not seen since before cutoff; returns how many.
func (s *Store) ExpireLeases(ctx context.Context, cutoff time.Time) (int, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM leases WHERE last_seen_at < ?`, cutoff.Unix())
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}
