package update

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"offmanual/desk/server-agent/internal/store"
)

func stage(t *testing.T, root, v string) {
	t.Helper()
	dir := filepath.Join(root, "versions", v)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "marker.txt"), []byte(v), 0o600); err != nil {
		t.Fatal(err)
	}
}

func marker(t *testing.T, root string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, "current", "marker.txt"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestSwitchCurrent(t *testing.T) {
	root := t.TempDir()
	stage(t, root, "1.0.0")
	stage(t, root, "1.1.0")
	if v, err := CurrentVersion(root); err != nil || v != "" {
		t.Fatalf("no current yet: %q %v", v, err)
	}
	if err := SwitchCurrent(root, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	if v, _ := CurrentVersion(root); v != "1.0.0" || marker(t, root) != "1.0.0" {
		t.Fatalf("current %q", v)
	}
	if err := SwitchCurrent(root, "1.1.0"); err != nil {
		t.Fatal(err)
	}
	if v, _ := CurrentVersion(root); v != "1.1.0" || marker(t, root) != "1.1.0" {
		t.Fatalf("current %q", v)
	}
	// The old version's files are untouched (only the link moved), and no helper links are left.
	if b, _ := os.ReadFile(filepath.Join(root, "versions", "1.0.0", "marker.txt")); string(b) != "1.0.0" {
		t.Fatal("old version damaged")
	}
	for _, n := range []string{"current.next", "current.prev"} {
		if _, err := os.Lstat(filepath.Join(root, n)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s left behind", n)
		}
	}
	// Refusals leave current where it was.
	for _, bad := range []string{"2.0.0", "../1.0.0", "latest", ""} {
		if err := SwitchCurrent(root, bad); err == nil {
			t.Fatalf("switched to %q", bad)
		}
	}
	if v, _ := CurrentVersion(root); v != "1.1.0" {
		t.Fatalf("current moved by a refused switch: %q", v)
	}
}

func switcherFixture(t *testing.T) (*Switcher, *store.Store, string, *time.Time) {
	t.Helper()
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	root := t.TempDir()
	stage(t, root, "1.0.0")
	stage(t, root, "1.1.0")
	if err := SwitchCurrent(root, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 24, 10, 0, 0, 0, ist) // working hours
	leases := 2
	w := &Switcher{Root: root, Store: st, AgentVersion: "1.0.0",
		ActiveLeases: func(context.Context) int { return leases },
		Now:          func() time.Time { return now }}
	t.Cleanup(func() { leases = 0 })
	return w, st, root, &now
}

func TestSwitcherWaitsForAQuietTime(t *testing.T) {
	w, st, root, now := switcherFixture(t)
	ctx := context.Background()
	if v, _ := w.Due(ctx); v != "" {
		t.Fatal("due with nothing staged")
	}
	_ = st.SetUpdateState(ctx, "1.1.0", "staged", "")
	if v, _ := w.Due(ctx); v != "" {
		t.Fatal("switched during working hours")
	}
	*now = time.Date(2026, 11, 25, 3, 0, 0, 0, ist)
	if v, _ := w.Due(ctx); v != "" {
		t.Fatal("switched at night while gateways are in use")
	}
	w.ActiveLeases = func(context.Context) int { return 0 }
	if err := w.Tick(ctx); !errors.Is(err, ErrRestartForUpdate) {
		t.Fatalf("tick: %v", err)
	}
	if v, _ := CurrentVersion(root); v != "1.1.0" {
		t.Fatalf("current %q", v)
	}
	if s, _ := st.UpdateState(ctx, "1.1.0"); s != "active" {
		t.Fatalf("state %q", s)
	}
	if v, _ := w.Due(ctx); v != "" {
		t.Fatal("due again after switching")
	}
}

func TestSwitcherSecurityDeadline(t *testing.T) {
	w, st, root, now := switcherFixture(t)
	ctx := context.Background()
	_ = st.SetUpdateState(ctx, "1.1.0", "staged", "")
	_ = st.SetUpdateMeta(ctx, "1.1.0", "security", now.Add(time.Hour))
	if v, _ := w.Due(ctx); v != "" {
		t.Fatal("security release switched before its deadline in working hours")
	}
	*now = now.Add(2 * time.Hour) // past the deadline, still working hours, gateways in use
	if err := w.Tick(ctx); !errors.Is(err, ErrRestartForUpdate) {
		t.Fatalf("tick: %v", err)
	}
	if v, _ := CurrentVersion(root); v != "1.1.0" {
		t.Fatalf("current %q", v)
	}
}

func TestSwitcherNeverGoesBack(t *testing.T) {
	w, st, root, now := switcherFixture(t)
	ctx := context.Background()
	if err := SwitchCurrent(root, "1.1.0"); err != nil {
		t.Fatal(err)
	}
	_ = st.SetUpdateState(ctx, "1.0.0", "staged", "") // an older release staged (e.g. a firm pin)
	*now = time.Date(2026, 11, 25, 3, 0, 0, 0, ist)
	w.ActiveLeases = func(context.Context) int { return 0 }
	if v, _ := w.Due(ctx); v != "" {
		t.Fatalf("would move current back to %q (rollback is per employee, ADR-048)", v)
	}
}

func TestSwitcherSameAgentNoRestart(t *testing.T) {
	w, st, _, now := switcherFixture(t)
	ctx := context.Background()
	w.AgentVersion = "1.1.0" // already running the staged release's agent (e.g. dev run)
	_ = st.SetUpdateState(ctx, "1.1.0", "staged", "")
	*now = time.Date(2026, 11, 25, 3, 0, 0, 0, ist)
	w.ActiveLeases = func(context.Context) int { return 0 }
	if err := w.Tick(ctx); err != nil {
		t.Fatalf("tick: %v", err)
	}
}
