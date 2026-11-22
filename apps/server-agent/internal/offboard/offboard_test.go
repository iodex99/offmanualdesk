package offboard

import (
	"archive/zip"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
	"time"

	"offmanual/desk/server-agent/internal/store"
)

const sid = "S-1-5-21-1-2-3-1101"

type fixture struct {
	st      *store.Store
	a       *Archiver
	profile string
	local   string
	clock   time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	f := &fixture{st: st, profile: t.TempDir(), clock: time.Date(2026, 11, 23, 10, 0, 0, 0, time.UTC)}
	st.SetClock(func() time.Time { return f.clock })
	f.local = filepath.Join(f.profile, "AppData", "Local", "OffManual")
	write(t, filepath.Join(f.local, "openclaw-state", "agents", "main", "sessions", "s1.jsonl"), "turn")
	write(t, filepath.Join(f.local, "openclaw-state", "review.json"), "{}")
	write(t, filepath.Join(f.local, "backups", "state-20261120T090000", "review.json"), "{}")
	write(t, filepath.Join(f.local, "desk", "version.json"), "{}")
	f.a = &Archiver{
		Store: st,
		Dir:   filepath.Join(t.TempDir(), "offboarded"),
		Profile: func(s string) (string, error) {
			if s != sid {
				return "", ErrNoProfile
			}
			return f.profile, nil
		},
		Now: func() time.Time { return f.clock },
	}
	if err := st.UpsertEmployee(ctx, store.Employee{SID: sid, EmployeeID: "e1", Name: "Asha", Status: "active", Packs: []string{"core"}}); err != nil {
		t.Fatal(err)
	}
	return f
}

func write(t *testing.T, p, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func exists(p string) bool { _, err := os.Lstat(p); return err == nil }

func archives(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range ents {
		out = append(out, e.Name())
	}
	return out
}

func zipNames(t *testing.T, p string) []string {
	t.Helper()
	r, err := zip.OpenReader(p)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Close() }()
	var out []string
	for _, f := range r.File {
		out = append(out, f.Name)
	}
	slices.Sort(out)
	return out
}

func TestArchiveAfterGraceRemoveThenPurge(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	if err := f.st.DisableEmployee(ctx, sid); err != nil {
		t.Fatal(err)
	}
	f.a.Pass(ctx)
	if len(archives(t, f.a.Dir)) != 0 || !exists(filepath.Join(f.local, "openclaw-state")) {
		t.Fatal("archived inside the grace period (Desk may still be stopping the gateway)")
	}

	f.clock = f.clock.Add(16 * time.Minute)
	f.a.Pass(ctx)
	got := archives(t, f.a.Dir)
	if len(got) != 1 || got[0] != sid+"-20261123T101600Z.zip" {
		t.Fatalf("archives %v", got)
	}
	want := []string{
		"backups/state-20261120T090000/review.json",
		"openclaw-state/agents/main/sessions/s1.jsonl",
		"openclaw-state/review.json",
	}
	if names := zipNames(t, filepath.Join(f.a.Dir, got[0])); !slices.Equal(names, want) {
		t.Fatalf("zip has %v", names)
	}
	if exists(filepath.Join(f.local, "openclaw-state")) || exists(filepath.Join(f.local, "backups")) {
		t.Fatal("originals left in the profile")
	}
	if !exists(filepath.Join(f.local, "desk", "version.json")) {
		t.Fatal("Desk settings removed")
	}

	f.clock = f.clock.Add(24 * time.Hour)
	f.a.Pass(ctx) // nothing more to do; a second pass must not archive again
	if len(archives(t, f.a.Dir)) != 1 {
		t.Fatal("archived twice")
	}

	f.a.Retention = func(context.Context) int { return 30 }
	f.clock = f.clock.Add(29 * 24 * time.Hour)
	f.a.Pass(ctx)
	if len(archives(t, f.a.Dir)) != 0 {
		t.Fatal("archive kept past the retention period")
	}
	sum, _ := f.st.AuditSummary(ctx, time.Time{}, f.clock.Add(time.Hour))
	if len(sum) != 1 || sum[0].Category != "offboarding" || sum[0].Count != 3 {
		t.Fatalf("audit %v, want archive + remove + purge", sum)
	}
}

func TestReenabledBeforeGraceKeepsState(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_ = f.st.DisableEmployee(ctx, sid)
	_ = f.st.UpsertEmployee(ctx, store.Employee{SID: sid, EmployeeID: "e1", Name: "Asha", Status: "active", Packs: []string{"core"}})
	_ = f.st.CancelOffboarding(ctx, sid)
	f.clock = f.clock.Add(time.Hour)
	f.a.Pass(ctx)
	if len(archives(t, f.a.Dir)) != 0 || !exists(filepath.Join(f.local, "openclaw-state", "review.json")) {
		t.Fatal("re-enabled employee's state archived or removed")
	}
	// Switched off again later: a new cycle.
	_ = f.st.DisableEmployee(ctx, sid)
	f.clock = f.clock.Add(time.Hour)
	f.a.Pass(ctx)
	if len(archives(t, f.a.Dir)) != 1 {
		t.Fatal("second offboarding not archived")
	}
}

func TestActiveEmployeeNeverArchived(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_ = f.st.DisableEmployee(ctx, sid)
	// Status flipped back by a sync without CancelOffboarding (belt and braces).
	_ = f.st.UpsertEmployee(ctx, store.Employee{SID: sid, EmployeeID: "e1", Name: "Asha", Status: "active", Packs: []string{"core"}})
	f.clock = f.clock.Add(time.Hour)
	f.a.Pass(ctx)
	if len(archives(t, f.a.Dir)) != 0 {
		t.Fatal("active employee archived")
	}
}

func TestNothingToArchive(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	other := "S-1-5-21-1-2-3-1199" // no profile on this server
	_ = f.st.UpsertEmployee(ctx, store.Employee{SID: other, EmployeeID: "e2", Name: "Ravi", Status: "active", Packs: []string{"core"}})
	_ = f.st.DisableEmployee(ctx, other)
	f.clock = f.clock.Add(time.Hour)
	f.a.Pass(ctx)
	if len(archives(t, f.a.Dir)) != 0 {
		t.Fatal("archive made without a profile")
	}
	if due, _ := f.st.OffboardingDue(ctx, 0); len(due) != 0 {
		t.Fatal("cycle without a profile still due")
	}
	f.a.Retention = func(context.Context) int { return 30 }
	f.clock = f.clock.Add(31 * 24 * time.Hour)
	f.a.Pass(ctx) // purge of an empty archive name is a no-op
	sum, _ := f.st.AuditSummary(ctx, time.Time{}, f.clock.Add(time.Hour))
	if len(sum) != 1 || sum[0].Count != 2 {
		t.Fatalf("audit %v, want archive(nothing) + purge", sum)
	}
}

func TestFailureIsRetried(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	_ = f.st.DisableEmployee(ctx, sid)
	f.clock = f.clock.Add(time.Hour)
	f.a.Profile = func(string) (string, error) { return "", errors.New("registry unreadable") }
	f.a.Pass(ctx)
	due, _ := f.st.OffboardingDue(ctx, 0)
	if len(due) != 1 || due[0].Attempts != 1 {
		t.Fatalf("failed attempt not recorded: %+v", due)
	}
	f.a.Profile = func(string) (string, error) { return f.profile, nil }
	f.a.Pass(ctx)
	if len(archives(t, f.a.Dir)) != 1 {
		t.Fatal("not archived on retry")
	}
}

func TestRelativeOrUNCProfileRefused(t *testing.T) {
	for _, p := range []string{`Users\asha`, `\\fileserver\profiles\asha`} {
		f := newFixture(t)
		ctx := context.Background()
		_ = f.st.DisableEmployee(ctx, sid)
		f.clock = f.clock.Add(time.Hour)
		f.a.Profile = func(string) (string, error) { return p, nil }
		f.a.Pass(ctx)
		if due, _ := f.st.OffboardingDue(ctx, 0); len(due) != 1 || due[0].Attempts != 1 {
			t.Fatalf("%s: accepted", p)
		}
	}
}

func TestBadSIDRefused(t *testing.T) {
	f := newFixture(t)
	if _, _, err := f.a.openLocal(`S-1-5-21-1-2-3-1101\..\..`); err == nil {
		t.Fatal("bad SID accepted")
	}
	if _, _, err := f.a.openLocal("S-1-5-18"); err == nil {
		t.Fatal("LocalSystem SID accepted")
	}
}

func TestPurgeChecksName(t *testing.T) {
	a := &Archiver{Dir: t.TempDir()}
	if err := a.purge(`..\agent.db`); err == nil {
		t.Fatal("path outside the archive folder accepted")
	}
	if err := a.purge(sid + "-20261123T101600Z.zip"); err != nil {
		t.Fatalf("missing archive should be fine: %v", err)
	}
}

// link makes a directory junction on Windows (no privilege needed) or a symlink elsewhere.
func link(t *testing.T, at, target string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		cmd := exec.Command("cmd", "/c", "mklink", "/J", at, target) //nolint:gosec // test temp dirs only
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("mklink: %v %s", err, out)
		}
		return
	}
	if err := os.Symlink(target, at); err != nil {
		t.Fatal(err)
	}
}

// A planted link must neither pull outside files into the archive nor let the
// LocalSystem clean-up delete them.
func TestLinksAreNotFollowed(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	outside := t.TempDir()
	write(t, filepath.Join(outside, "secret.txt"), "other user's file")
	link(t, filepath.Join(f.local, "openclaw-state", "escape"), outside)

	_ = f.st.DisableEmployee(ctx, sid)
	f.clock = f.clock.Add(time.Hour)
	f.a.Pass(ctx)
	got := archives(t, f.a.Dir)
	if len(got) != 1 {
		t.Fatalf("archives %v", got)
	}
	for _, n := range zipNames(t, filepath.Join(f.a.Dir, got[0])) {
		if filepath.Base(n) == "secret.txt" {
			t.Fatal("followed a link into another folder")
		}
	}
	if !exists(filepath.Join(outside, "secret.txt")) {
		t.Fatal("clean-up deleted a file through a link")
	}
	if exists(filepath.Join(f.local, "openclaw-state")) {
		t.Fatal("state folder not removed")
	}
}

// The state folder itself replaced by a link: nothing outside is archived or deleted.
func TestStateFolderReplacedByLink(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	outside := t.TempDir()
	write(t, filepath.Join(outside, "secret.txt"), "other user's file")
	if err := os.RemoveAll(filepath.Join(f.local, "openclaw-state")); err != nil {
		t.Fatal(err)
	}
	link(t, filepath.Join(f.local, "openclaw-state"), outside)

	_ = f.st.DisableEmployee(ctx, sid)
	f.clock = f.clock.Add(time.Hour)
	f.a.Pass(ctx)
	got := archives(t, f.a.Dir)
	if len(got) != 1 {
		t.Fatalf("archives %v", got)
	}
	for _, n := range zipNames(t, filepath.Join(f.a.Dir, got[0])) {
		if filepath.Base(n) == "secret.txt" {
			t.Fatal("archived through a linked state folder")
		}
	}
	if !exists(filepath.Join(outside, "secret.txt")) {
		t.Fatal("deleted through a linked state folder")
	}
}

// The OffManual folder itself replaced by a link pointing outside the profile.
func TestLocalFolderLinkOutsideProfileRefused(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	outside := t.TempDir()
	write(t, filepath.Join(outside, "openclaw-state", "secret.txt"), "x")
	if err := os.RemoveAll(f.local); err != nil {
		t.Fatal(err)
	}
	link(t, f.local, outside)

	_ = f.st.DisableEmployee(ctx, sid)
	f.clock = f.clock.Add(time.Hour)
	f.a.Pass(ctx)
	if len(archives(t, f.a.Dir)) != 0 {
		t.Fatal("archived through a link that leaves the profile")
	}
	if !exists(filepath.Join(outside, "openclaw-state", "secret.txt")) {
		t.Fatal("deleted outside the profile")
	}
	if due, _ := f.st.OffboardingDue(ctx, 0); len(due) != 1 || due[0].Attempts != 1 {
		t.Fatal("escape not recorded as a failure")
	}
}
