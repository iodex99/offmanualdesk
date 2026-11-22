package app

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"offmanual/desk/server-agent/internal/store"
)

func openStore(t *testing.T, path string) *store.Store {
	t.Helper()
	st, err := store.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func names(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range ents {
		out = append(out, e.Name())
	}
	slices.Sort(out)
	return out
}

func TestDailyBackupOncePerISTDayKeepsSeven(t *testing.T) {
	ctx := context.Background()
	st := openStore(t, filepath.Join(t.TempDir(), "agent.db"))
	t.Cleanup(func() { _ = st.Close() })
	dir := filepath.Join(t.TempDir(), "backups", "agent")
	// 23-11-2026 19:00 UTC is 24-11-2026 00:30 IST: the IST date names the file.
	day := time.Date(2026, 11, 23, 19, 0, 0, 0, time.UTC)
	name, err := dailyBackup(ctx, st, dir, day)
	if err != nil || filepath.Base(name) != "agent-20261124.db" {
		t.Fatalf("%q %v", name, err)
	}
	if again, err := dailyBackup(ctx, st, dir, day.Add(time.Hour)); err != nil || again != "" {
		t.Fatalf("second backup the same day: %q %v", again, err)
	}
	_ = os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("kept"), 0o600) // not ours: never pruned
	for i := 1; i <= 8; i++ {
		if _, err := dailyBackup(ctx, st, dir, day.AddDate(0, 0, i)); err != nil {
			t.Fatal(err)
		}
	}
	got := names(t, dir)
	want := []string{"agent-20261126.db", "agent-20261127.db", "agent-20261128.db", "agent-20261129.db",
		"agent-20261130.db", "agent-20261201.db", "agent-20261202.db", "notes.txt"}
	if !slices.Equal(got, want) {
		t.Fatalf("kept %v", got)
	}
	// A backup is a working database.
	b := openStore(t, filepath.Join(dir, "agent-20261202.db"))
	defer func() { _ = b.Close() }()
	if err := b.IntegrityCheck(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestRestoreReplacesAndKeepsThePrevious(t *testing.T) {
	ctx := context.Background()
	data := t.TempDir()
	st := openStore(t, filepath.Join(data, "agent.db"))
	if err := st.UpsertEmployee(ctx, store.Employee{SID: "S-1-5-21-1-2-3-1101", EmployeeID: "e1", Name: "Asha", Status: "active", Packs: []string{"core"}}); err != nil {
		t.Fatal(err)
	}
	backup, err := dailyBackup(ctx, st, agentBackupDir(data), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// After the backup: Ravi is added, then the database is "lost" by restoring.
	_ = st.UpsertEmployee(ctx, store.Employee{SID: "S-1-5-21-1-2-3-1102", EmployeeID: "e2", Name: "Ravi", Status: "active", Packs: []string{"core"}})
	_ = st.Close()

	var out bytes.Buffer
	if err := Restore(ctx, data, backup, func() bool { return false }, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "sc start OffManualAgent") {
		t.Fatalf("output %q", out.String())
	}
	r := openStore(t, filepath.Join(data, "agent.db"))
	defer func() { _ = r.Close() }()
	sids, _ := r.EmployeeSIDs(ctx)
	if !slices.Equal(sids, []string{"S-1-5-21-1-2-3-1101"}) {
		t.Fatalf("restored employees %v", sids)
	}
	var kept bool
	for _, n := range names(t, agentBackupDir(data)) {
		if strings.HasPrefix(n, "before-restore-") && strings.HasSuffix(n, ".db") {
			kept = true
		}
	}
	if !kept {
		t.Fatal("previous database not kept")
	}
}

func TestRestoreRefusals(t *testing.T) {
	ctx := context.Background()
	data := t.TempDir()
	st := openStore(t, filepath.Join(data, "agent.db"))
	_ = st.Close()
	before, _ := os.ReadFile(filepath.Join(data, "agent.db"))

	if err := Restore(ctx, data, "x.db", func() bool { return true }, &bytes.Buffer{}); !errors.Is(err, ErrServiceRunning) {
		t.Fatalf("running service: %v", err)
	}
	junk := filepath.Join(t.TempDir(), "junk.db")
	_ = os.WriteFile(junk, bytes.Repeat([]byte("not sqlite "), 500), 0o600)
	if err := Restore(ctx, data, junk, nil, &bytes.Buffer{}); err == nil {
		t.Fatal("junk file restored")
	}
	if err := Restore(ctx, data, filepath.Join(data, "missing.db"), nil, &bytes.Buffer{}); err == nil {
		t.Fatal("missing file restored")
	}
	after, _ := os.ReadFile(filepath.Join(data, "agent.db"))
	if !bytes.Equal(before, after) {
		t.Fatal("a refused restore changed agent.db")
	}
	if _, err := os.Stat(filepath.Join(data, "agent.db.restore")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("temporary copy left behind")
	}
}

func TestServiceBinaryPathFollowsCurrent(t *testing.T) {
	root := filepath.Join("C:"+string(filepath.Separator), "Program Files", "OffManual")
	in := filepath.Join(root, "versions", "1.2.0", "server-agent.exe")
	if got, want := serviceBinaryPath(root, in), filepath.Join(root, "current", "server-agent.exe"); got != want {
		t.Fatalf("%q, want %q", got, want)
	}
	for _, p := range []string{
		filepath.Join(root, "current", "server-agent.exe"),
		filepath.Join("D:"+string(filepath.Separator), "dev", "server-agent.exe"),
		filepath.Join(root, "versions", "server-agent.exe"),
	} {
		if got := serviceBinaryPath(root, p); got != p {
			t.Fatalf("%q changed to %q", p, got)
		}
	}
}
