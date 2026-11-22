package update

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"offmanual/desk/server-agent/internal/store"
	"offmanual/desk/server-agent/pkg/manifest"
)

// Moving `current` (UPDATES §3 steps 3–4, ADR-062). Each employee's gateway already
// runs from versions\<their choice> (ADR-048), so `current` only decides what new
// launches of the Server Agent, Desk and the guard's bridge use. Running processes keep
// the files they loaded.

// ErrRestartForUpdate asks the service to exit so SCM recovery starts the new binary.
var ErrRestartForUpdate = errors.New("restarting to run the new Server Agent")

// CurrentVersion returns the version `<root>\current` points to ("" when it doesn't exist).
func CurrentVersion(root string) (string, error) {
	target, err := os.Readlink(filepath.Join(root, "current"))
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return filepath.Base(filepath.Clean(target)), nil
}

// SwitchCurrent points `<root>\current` at `<root>\versions\<version>`. The new link is
// made first as current.next, then swapped in by rename; on failure the old link is put
// back. Only staged versions (with their signed manifest) can be targets.
func SwitchCurrent(root, version string) error {
	if _, err := manifest.CompareVersions(version, version); err != nil {
		return fmt.Errorf("switch current: %w", err)
	}
	target := filepath.Join(root, "versions", version)
	if fi, err := os.Stat(filepath.Join(target, "manifest.json")); err != nil || !fi.Mode().IsRegular() {
		return fmt.Errorf("switch current: version %s is not staged", version)
	}
	link := filepath.Join(root, "current")
	next := link + ".next"
	prev := link + ".prev"
	_ = os.Remove(next) // a link left by an interrupted switch (removes the link, not the target)
	_ = os.Remove(prev)
	if err := makeDirLink(next, target); err != nil {
		return fmt.Errorf("switch current: %w", err)
	}
	hadOld := false
	if _, err := os.Lstat(link); err == nil {
		if err := os.Rename(link, prev); err != nil {
			_ = os.Remove(next)
			return fmt.Errorf("switch current: %w", err)
		}
		hadOld = true
	}
	if err := os.Rename(next, link); err != nil {
		if hadOld {
			_ = os.Rename(prev, link)
		}
		_ = os.Remove(next)
		return fmt.Errorf("switch current: %w", err)
	}
	if hadOld {
		_ = os.Remove(prev)
	}
	return nil
}

// Switcher decides when to move `current` to the staged release.
type Switcher struct {
	Root         string // C:\Program Files\OffManual
	Store        *store.Store
	AgentVersion string
	// ActiveLeases counts gateways in use (leases renewed in the last hour).
	ActiveLeases func(ctx context.Context) int
	Now          func() time.Time
}

var ist = time.FixedZone("IST", 5*3600+1800)

// quiet is 02:00–05:00 IST: the switch restarts the Server Agent for a few seconds.
func quiet(t time.Time) bool {
	h := t.In(ist).Hour()
	return h >= 2 && h < 5
}

// Due returns the staged version to switch to now, or "".
func (w *Switcher) Due(ctx context.Context) (string, error) {
	rel, err := w.Store.StagedRelease(ctx)
	if err != nil || rel.Version == "" {
		return "", err
	}
	cur, err := CurrentVersion(w.Root)
	if err != nil {
		return "", err
	}
	if cur != "" {
		if c, err := manifest.CompareVersions(rel.Version, cur); err != nil || c <= 0 {
			return "", nil // not newer than what current points to (or unreadable)
		}
	}
	now := w.now()
	if rel.Severity == "security" && !rel.Deadline.IsZero() && now.After(rel.Deadline) {
		return rel.Version, nil
	}
	if quiet(now) && (w.ActiveLeases == nil || w.ActiveLeases(ctx) == 0) {
		return rel.Version, nil
	}
	return "", nil
}

// Tick switches when due. It returns ErrRestartForUpdate when the Server Agent itself
// changed and must restart.
func (w *Switcher) Tick(ctx context.Context) error {
	v, err := w.Due(ctx)
	if err != nil || v == "" {
		return err
	}
	if err := SwitchCurrent(w.Root, v); err != nil {
		_ = w.Store.SetUpdateState(ctx, v, "failed", err.Error())
		return err
	}
	if err := w.Store.SetUpdateState(ctx, v, "active", ""); err != nil {
		return err
	}
	if v != w.AgentVersion {
		return ErrRestartForUpdate
	}
	return nil
}

func (w *Switcher) now() time.Time {
	if w.Now != nil {
		return w.Now()
	}
	return time.Now()
}
