package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"time"

	"offmanual/desk/server-agent/internal/store"
)

// Daily backups of agent.db (M11, ADR-060). agent.db holds the employees'
// authenticator secrets (DPAPI, this machine), leases, policy and the console
// identity; losing it means every employee sets up their authenticator again and the
// server is enrolled again. Employees' own assistant state lives in their Windows
// profiles and is covered by the firm's normal profile backup.

const backupKeep = 7

var (
	ist          = time.FixedZone("IST", 5*3600+1800)
	backupNameRe = regexp.MustCompile(`^agent-[0-9]{8}\.db$`)
)

func agentBackupDir(dataDir string) string {
	return filepath.Join(dataDir, "backups", "agent")
}

// dailyBackup writes today's backup (IST date) if it doesn't exist yet and keeps the
// newest seven. Returns the file written ("" when today's already existed).
func dailyBackup(ctx context.Context, st *store.Store, dir string, now time.Time) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	name := "agent-" + now.In(ist).Format("20060102") + ".db"
	final := filepath.Join(dir, name)
	if _, err := os.Stat(final); err == nil {
		return "", pruneBackups(dir)
	}
	tmp := final + ".partial"
	_ = os.Remove(tmp) // a previous attempt that died half-way
	if err := st.Backup(ctx, tmp); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return final, pruneBackups(dir)
}

func pruneBackups(dir string) error {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var names []string
	for _, e := range ents {
		if e.Type().IsRegular() && backupNameRe.MatchString(e.Name()) {
			names = append(names, e.Name())
		}
	}
	slices.Sort(names) // the date in the name sorts by time
	for len(names) > backupKeep {
		if err := os.Remove(filepath.Join(dir, names[0])); err != nil {
			return err
		}
		names = names[1:]
	}
	return nil
}

// backupLoop makes the day's backup at start and checks again every hour.
func backupLoop(ctx context.Context, st *store.Store, dir string, log *slog.Logger) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		if name, err := dailyBackup(ctx, st, dir, time.Now()); err != nil {
			log.Warn("agent.db backup failed", "error", err.Error())
		} else if name != "" {
			log.Info("agent.db backed up", "file", filepath.Base(name))
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// ErrServiceRunning means restore was attempted while the Server Agent runs.
var ErrServiceRunning = errors.New("stop the OffManualAgent service first: sc stop OffManualAgent")

// Restore replaces agent.db with a backup. The service must be stopped. The backup is
// checked (opens, migrates, passes the integrity check) on a copy before anything is
// replaced; the current database is kept next to the backups as before-restore-<time>.
// DPAPI-protected secrets inside only open on the server that made the backup.
func Restore(ctx context.Context, dataDir, from string, running func() bool, out io.Writer) error {
	if dataDir == "" {
		dataDir = DefaultDataDir()
	}
	if running != nil && running() {
		return ErrServiceRunning
	}
	db := filepath.Join(dataDir, "agent.db")
	tmp := db + ".restore"
	_ = os.Remove(tmp)
	if err := copyFile(from, tmp); err != nil {
		return fmt.Errorf("read backup: %w", err)
	}
	st, err := store.Open(ctx, tmp)
	if err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("backup doesn't open: %w", err)
	}
	checkErr := st.IntegrityCheck(ctx)
	v, verr := st.SchemaVersion(ctx)
	_ = st.Close()
	for _, side := range []string{tmp + "-wal", tmp + "-shm"} {
		_ = os.Remove(side) // checkpointed on close
	}
	if checkErr != nil || verr != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("backup is damaged: %w", errors.Join(checkErr, verr))
	}
	keep := agentBackupDir(dataDir)
	if err := os.MkdirAll(keep, 0o700); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if _, err := os.Stat(db + suffix); err == nil {
			if err := os.Rename(db+suffix, filepath.Join(keep, "before-restore-"+stamp+".db"+suffix)); err != nil {
				_ = os.Remove(tmp)
				return fmt.Errorf("keep current database: %w", err)
			}
		}
	}
	if err := os.Rename(tmp, db); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(out, "Restored agent.db (schema version %d). The previous database is in %s.\nStart the service: sc start OffManualAgent\n", v, keep)
	return nil
}

func copyFile(src, dst string) (err error) {
	in, err := os.Open(src) //nolint:gosec // an administrator names the backup file on the command line
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	o, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := o.Close(); err == nil {
			err = cerr
		}
	}()
	_, err = io.Copy(o, in)
	return err
}
