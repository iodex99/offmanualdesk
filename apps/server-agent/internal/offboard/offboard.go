// Package offboard archives a switched-off employee's assistant state and purges the
// archive after the firm's retention period (F10, ADR-056).
//
// The Server Agent runs as LocalSystem and works inside a folder the employee could
// write to, so every file operation goes through os.Root: names are resolved
// handle-relative and symbolic links or junctions can't lead outside the employee's
// OffManual folder. Links inside it are never followed: only regular files are archived
// and RemoveAll removes a link, not its target.
package offboard

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"offmanual/desk/server-agent/internal/store"
)

// Folders under %LOCALAPPDATA%\OffManual that hold the employee's assistant data
// (ARCHITECTURE §5): the gateway state and Desk's pre-Doctor snapshots of it. Desk's own
// settings (desk\) and the DPAPI device key are useless to anyone else and stay.
var stateFolders = []string{"openclaw-state", "backups"}

// localDir is %LOCALAPPDATA%\OffManual relative to the profile folder.
// [A] L-offboard: confirm LOCALAPPDATA is <profile>\AppData\Local on the RDS host; with
// FSLogix the profile is only mounted while the employee is signed in (then nothing is found).
var localDir = filepath.Join("AppData", "Local", "OffManual")

var (
	sidRe     = regexp.MustCompile(`^S-1-5-21(-[0-9]{1,10}){4}$`)
	archiveRe = regexp.MustCompile(`^S-1-5-21(-[0-9]{1,10}){4}-[0-9]{8}T[0-9]{6}Z\.zip$`)
)

// Defaults.
const (
	DefaultGrace         = 15 * time.Minute // Desk stops the gateway within a minute (ADR-042 check)
	DefaultRetentionDays = 180              // SECURITY.md: archived agent state, default 180 days
)

// ErrNoProfile means Windows has no profile for the SID on this server.
var ErrNoProfile = errors.New("no profile on this server")

// Archiver runs offboarding passes.
type Archiver struct {
	Store *store.Store
	// Dir is where archives are kept: %ProgramData%\OffManual\backups\offboarded
	// (inherits SYSTEM + Administrators only, ADR-033).
	Dir string
	// Profile returns the employee's profile folder (ProfilePath on Windows).
	Profile func(sid string) (string, error)
	// Retention returns the firm's retention in days (policy retentionDays).
	Retention func(ctx context.Context) int
	Grace     time.Duration
	Now       func() time.Time
	Log       *slog.Logger
}

// Loop runs a pass now and then every interval until ctx ends.
func (a *Archiver) Loop(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		a.Pass(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Pass archives due cycles, removes archived originals and purges old archives.
// Failures are recorded on the cycle and retried next pass.
func (a *Archiver) Pass(ctx context.Context) {
	grace := a.Grace
	if grace == 0 {
		grace = DefaultGrace
	}
	due, err := a.Store.OffboardingDue(ctx, grace)
	if err != nil {
		a.log().Warn("offboarding: list failed", "error", err.Error())
	}
	for _, o := range due {
		name, err := a.archive(o.SID)
		if err != nil {
			a.fail(ctx, o, "archive", err)
			continue
		}
		if err := a.Store.OffboardingArchived(ctx, o.ID, name); err != nil {
			a.log().Warn("offboarding: record failed", "error", err.Error())
			continue
		}
		result := "ok"
		if name == "" {
			result = "nothing"
			_ = a.Store.OffboardingCleaned(ctx, o.ID) // nothing in the profile to remove
		}
		a.audit(ctx, o.SID, "archive", result)
	}

	cleanup, err := a.Store.OffboardingCleanupDue(ctx)
	if err != nil {
		a.log().Warn("offboarding: list failed", "error", err.Error())
	}
	for _, o := range cleanup {
		if err := a.removeOriginals(o.SID); err != nil {
			a.fail(ctx, o, "remove", err)
			continue
		}
		_ = a.Store.OffboardingCleaned(ctx, o.ID)
		a.audit(ctx, o.SID, "remove", "ok")
	}

	days := DefaultRetentionDays
	if a.Retention != nil {
		if d := a.Retention(ctx); d > 0 {
			days = d
		}
	}
	purge, err := a.Store.OffboardingPurgeDue(ctx, time.Duration(days)*24*time.Hour)
	if err != nil {
		a.log().Warn("offboarding: list failed", "error", err.Error())
	}
	for _, o := range purge {
		if err := a.purge(o.ArchiveName); err != nil {
			a.fail(ctx, o, "purge", err)
			continue
		}
		_ = a.Store.OffboardingPurged(ctx, o.ID)
		a.audit(ctx, o.SID, "purge", "ok")
	}
}

func (a *Archiver) fail(ctx context.Context, o store.Offboarding, action string, err error) {
	reason := plainReason(err)
	_ = a.Store.OffboardingFailed(ctx, o.ID, reason)
	a.audit(ctx, o.SID, action, "failed")
	// Metadata only: the cycle id and a reason without file names.
	a.log().Warn("offboarding step failed", "step", action, "cycle", o.ID, "attempts", o.Attempts+1, "reason", reason)
}

func (a *Archiver) audit(ctx context.Context, sid, action, result string) {
	_ = a.Store.AppendAudit(ctx, store.AuditEvent{SID: sid, Category: "offboarding", Action: action, Result: result})
}

func (a *Archiver) log() *slog.Logger {
	if a.Log != nil {
		return a.Log
	}
	return slog.Default()
}

func (a *Archiver) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now()
}

// openLocal opens the employee's OffManual folder as a Root. found is false when the
// profile or the folder doesn't exist (nothing to archive).
func (a *Archiver) openLocal(sid string) (root *os.Root, found bool, err error) {
	if !sidRe.MatchString(sid) {
		return nil, false, errors.New("not a domain or local account SID")
	}
	profile, err := a.Profile(sid)
	if errors.Is(err, ErrNoProfile) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if !filepath.IsAbs(profile) || strings.HasPrefix(profile, `\\`) {
		return nil, false, errors.New("profile path is not a local absolute path")
	}
	// The profile folder itself sits in a folder the employee can't change (C:\Users);
	// everything below it is resolved inside this Root.
	pr, err := os.OpenRoot(profile)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = pr.Close() }()
	root, err = pr.OpenRoot(localDir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return root, true, nil
}

// archive zips the state folders into Dir and returns the archive's name ("" when
// there was nothing to archive).
func (a *Archiver) archive(sid string) (string, error) {
	root, found, err := a.openLocal(sid)
	if err != nil || !found {
		return "", err
	}
	defer func() { _ = root.Close() }()
	var present []string
	for _, f := range stateFolders {
		fi, err := root.Lstat(f)
		if err == nil && fi.IsDir() {
			present = append(present, f)
		}
	}
	if len(present) == 0 {
		return "", nil
	}
	if err := os.MkdirAll(a.Dir, 0o700); err != nil {
		return "", err
	}
	name := sid + "-" + a.now().UTC().Format("20060102T150405Z") + ".zip"
	final := filepath.Join(a.Dir, name)
	tmp := final + ".partial"
	if err := writeZip(tmp, root.FS(), present); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return name, nil
}

func writeZip(dst string, fsys fs.FS, folders []string) (err error) {
	f, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := f.Close(); err == nil {
			err = cerr
		}
	}()
	zw := zip.NewWriter(f)
	for _, folder := range folders {
		err := fs.WalkDir(fsys, folder, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			// Only directories and regular files: links and other reparse points are
			// skipped, never followed.
			if d.IsDir() || !d.Type().IsRegular() {
				return nil
			}
			return addFile(zw, fsys, p)
		})
		if err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	return f.Sync()
}

func addFile(zw *zip.Writer, fsys fs.FS, p string) error {
	src, err := fsys.Open(p)
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()
	info, err := src.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return nil
	}
	h, err := zip.FileInfoHeader(info)
	if err != nil {
		return err
	}
	h.Name = path.Clean(p)
	h.Method = zip.Deflate
	w, err := zw.CreateHeader(h)
	if err != nil {
		return err
	}
	_, err = io.Copy(w, src)
	return err
}

// removeOriginals deletes the state folders from the profile, inside the Root.
func (a *Archiver) removeOriginals(sid string) error {
	root, found, err := a.openLocal(sid)
	if err != nil || !found {
		return err
	}
	defer func() { _ = root.Close() }()
	for _, f := range stateFolders {
		if err := root.RemoveAll(f); err != nil {
			return err
		}
	}
	return nil
}

// purge deletes one archive from Dir. Names come from our own store but are still
// checked against the exact pattern before use.
func (a *Archiver) purge(name string) error {
	if name == "" {
		return nil // nothing was archived
	}
	if !archiveRe.MatchString(name) {
		return fmt.Errorf("unexpected archive name")
	}
	err := os.Remove(filepath.Join(a.Dir, name))
	if errors.Is(err, fs.ErrNotExist) {
		return nil // removed by hand already
	}
	return err
}

// plainReason turns an error into a short reason without paths (logs and the store
// keep metadata only).
func plainReason(err error) string {
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return pe.Op + ": " + pe.Err.Error()
	}
	var le *os.LinkError
	if errors.As(err, &le) {
		return le.Op + ": " + le.Err.Error()
	}
	s := err.Error()
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}
