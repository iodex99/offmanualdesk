package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 22, 9, 0, 0, 0, time.UTC)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(context.Background(), filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	clock := t0
	s.SetClock(func() time.Time { return clock })
	return s
}

func addEmployee(t *testing.T, s *Store, sid string) {
	t.Helper()
	if err := s.UpsertEmployee(context.Background(), Employee{SID: sid, EmployeeID: "e-" + sid, Name: "Asha", Status: "active", Packs: []string{"core"}}); err != nil {
		t.Fatal(err)
	}
}

func TestMigrationsApplyOnceAndReopen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "agent.db")
	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	v, _ := s.SchemaVersion(ctx)
	if v != 7 {
		t.Fatalf("schema version %d, want 7", v)
	}
	_ = s.SetMeta(ctx, "server_id", "srv-1")
	_ = s.Close()
	s2, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer func() { _ = s2.Close() }()
	if got, _ := s2.Meta(ctx, "server_id"); got != "srv-1" {
		t.Fatalf("meta lost across reopen: %q", got)
	}
}

func TestRefusesNewerSchema(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "agent.db")
	s, _ := Open(ctx, path)
	_, _ = s.db.ExecContext(ctx, `INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, 'future', 0)`)
	_ = s.Close()
	if _, err := Open(ctx, path); err == nil {
		t.Fatal("older agent opened a newer database")
	}
}

func TestMemoryDatabase(t *testing.T) {
	s, err := Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if _, err := s.Meta(context.Background(), "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestEmployeesAndSecrets(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if _, err := s.Employee(ctx, "S-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	addEmployee(t, s, "S-1")
	if err := s.SetTOTPSecret(ctx, "S-1", []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	if err := s.AdvanceTOTPCounter(ctx, "S-1", 100); err != nil {
		t.Fatal(err)
	}
	_ = s.AdvanceTOTPCounter(ctx, "S-1", 90) // must not move backwards
	_ = s.SetPINHash(ctx, "S-1", "$argon2id$x")
	// Policy sync must not wipe secrets.
	_ = s.UpsertEmployee(ctx, Employee{SID: "S-1", EmployeeID: "e-S-1", Name: "Asha M", Status: "active", Packs: []string{"core", "tally-read"}})
	e, err := s.Employee(ctx, "S-1")
	if err != nil {
		t.Fatal(err)
	}
	if e.Name != "Asha M" || len(e.Packs) != 2 || e.TOTPLastCounter != 100 || e.PINHash != "$argon2id$x" || len(e.TOTPSecretDPAPI) != 3 {
		t.Fatalf("unexpected employee %+v", e)
	}
	if !e.TOTPEnrolledAt.IsZero() {
		t.Fatal("secret enrolled before confirmation")
	}
	if err := s.ConfirmTOTP(ctx, "S-1"); err != nil {
		t.Fatal(err)
	}
	if e2, _ := s.Employee(ctx, "S-1"); !e2.TOTPEnrolledAt.Equal(t0) {
		t.Fatalf("enrolled_at %v", e2.TOTPEnrolledAt)
	}
	_ = s.SetTOTPSecret(ctx, "S-1", []byte{9})
	if e3, _ := s.Employee(ctx, "S-1"); !e3.TOTPEnrolledAt.IsZero() || e3.TOTPLastCounter != 0 {
		t.Fatalf("re-enrol must reset: %+v", e3)
	}
	if err := s.SetPINHash(ctx, "S-404", "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown sid: want ErrNotFound, got %v", err)
	}
	if err := s.UpsertEmployee(ctx, Employee{SID: "S-2", EmployeeID: "e2", Name: "x", Status: "bogus"}); err == nil {
		t.Fatal("invalid status accepted")
	}
}

func TestDayGrant(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	addEmployee(t, s, "S-1")
	if ok, _ := s.DayGrantValid(ctx, "S-1"); ok {
		t.Fatal("grant without unlock")
	}
	_ = s.GrantDay(ctx, "S-1", t0.Add(9*time.Hour))
	if ok, _ := s.DayGrantValid(ctx, "S-1"); !ok {
		t.Fatal("grant not valid")
	}
	s.SetClock(func() time.Time { return t0.Add(10 * time.Hour) })
	if ok, _ := s.DayGrantValid(ctx, "S-1"); ok {
		t.Fatal("expired grant still valid")
	}
	_ = s.GrantDay(ctx, "S-1", t0.Add(20*time.Hour))
	_ = s.RevokeDay(ctx, "S-1")
	if ok, _ := s.DayGrantValid(ctx, "S-1"); ok {
		t.Fatal("revoked grant still valid")
	}
}

func TestLockStateRoundTrip(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	addEmployee(t, s, "S-1")
	l, _ := s.Lock(ctx, "S-1")
	if !l.DeskLocked || l.FailedPINs != 0 {
		t.Fatalf("default must be locked/no failures: %+v", l)
	}
	want := LockState{DeskLocked: false, TelegramUnlockedUntil: t0.Add(time.Hour), FailedPINs: 2, FailedCodes: 1, LockoutUntil: t0.Add(15 * time.Minute)}
	_ = s.SaveLock(ctx, "S-1", want)
	got, _ := s.Lock(ctx, "S-1")
	if got.DeskLocked || got.FailedPINs != 2 || got.FailedCodes != 1 || !got.LockoutUntil.Equal(want.LockoutUntil) || !got.TelegramUnlockedUntil.Equal(want.TelegramUnlockedUntil) {
		t.Fatalf("round trip %+v", got)
	}
}

func TestAuditSummaryHasCountsOnly(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	for _, c := range []string{"access_denied", "access_denied", "review_approved"} {
		if err := s.AppendAudit(ctx, AuditEvent{SID: "S-1", Category: c, Action: "read", Target: `\\fs\Clients\Mehta\bank.pdf`, Result: "denied"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.AppendAudit(ctx, AuditEvent{SID: "S-1"}); err == nil {
		t.Fatal("incomplete audit event accepted")
	}
	sum, err := s.AuditSummary(ctx, t0.Add(-time.Hour), t0.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(sum) != 2 || sum[0] != (AuditCount{"access_denied", 2}) || sum[1] != (AuditCount{"review_approved", 1}) {
		t.Fatalf("summary %+v", sum)
	}
	empty, _ := s.AuditSummary(ctx, t0.Add(time.Hour), t0.Add(2*time.Hour))
	if len(empty) != 0 {
		t.Fatalf("window not respected: %+v", empty)
	}
}

func TestLeasesStableLowestFreeAndExhaustion(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	a, err := s.AcquireLease(ctx, "S-A", 18800, 18802, "h1")
	if err != nil || a.Port != 18800 {
		t.Fatalf("A: %+v %v", a, err)
	}
	b, _ := s.AcquireLease(ctx, "S-B", 18800, 18802, "h2")
	c, _ := s.AcquireLease(ctx, "S-C", 18800, 18802, "h3")
	if b.Port != 18801 || c.Port != 18802 {
		t.Fatalf("ports %d %d", b.Port, c.Port)
	}
	if _, err := s.AcquireLease(ctx, "S-D", 18800, 18802, "h4"); !errors.Is(err, ErrNoFreePort) {
		t.Fatalf("want ErrNoFreePort, got %v", err)
	}
	// Re-acquiring keeps the same port and replaces the token hash.
	a2, _ := s.AcquireLease(ctx, "S-A", 18800, 18802, "h1b")
	if a2.Port != 18800 {
		t.Fatalf("port not stable: %d", a2.Port)
	}
	got, _ := s.LeaseFor(ctx, "S-A")
	if got.TokenHash != "h1b" {
		t.Fatalf("token hash not replaced: %+v", got)
	}
	// Releasing B frees the lowest gap for D.
	_ = s.ReleaseLease(ctx, "S-B")
	d, _ := s.AcquireLease(ctx, "S-D", 18800, 18802, "h4")
	if d.Port != 18801 {
		t.Fatalf("gap not reused: %d", d.Port)
	}
	// A narrowed range moves an out-of-range lease.
	e, _ := s.AcquireLease(ctx, "S-C", 18900, 18901, "h5")
	if e.Port != 18900 {
		t.Fatalf("out-of-range lease not moved: %d", e.Port)
	}
	if _, err := s.AcquireLease(ctx, "S-X", 5, 1, "h"); err == nil {
		t.Fatal("bad range accepted")
	}
}

func TestLeaseTouchAndExpire(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	_, _ = s.AcquireLease(ctx, "S-A", 18800, 18900, "h")
	_, _ = s.AcquireLease(ctx, "S-B", 18800, 18900, "h")
	s.SetClock(func() time.Time { return t0.Add(10 * time.Minute) })
	if err := s.TouchLease(ctx, "S-A", 4242); err != nil {
		t.Fatal(err)
	}
	n, err := s.ExpireLeases(ctx, t0.Add(5*time.Minute))
	if err != nil || n != 1 {
		t.Fatalf("expired %d (%v), want 1", n, err)
	}
	if _, err := s.LeaseFor(ctx, "S-B"); !errors.Is(err, ErrNotFound) {
		t.Fatal("stale lease survived")
	}
	a, _ := s.LeaseFor(ctx, "S-A")
	if a.PID != 4242 {
		t.Fatalf("pid not recorded: %+v", a)
	}
	if err := s.TouchLease(ctx, "S-Z", 1); !errors.Is(err, ErrNotFound) {
		t.Fatal("touch on missing lease succeeded")
	}
}

func TestStagedReleaseMeta(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if r, _ := s.StagedRelease(ctx); r.Version != "" {
		t.Fatalf("empty store: %+v", r)
	}
	_ = s.SetUpdateMeta(ctx, "9.9.9", "security", time.Now()) // unknown version: no-op
	_ = s.SetUpdateState(ctx, "1.1.0", "staged", "")
	d := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)
	if err := s.SetUpdateMeta(ctx, "1.1.0", "security", d); err != nil {
		t.Fatal(err)
	}
	r, err := s.StagedRelease(ctx)
	if err != nil || r.Version != "1.1.0" || r.Severity != "security" || !r.Deadline.Equal(d) {
		t.Fatalf("staged: %+v %v", r, err)
	}
	_ = s.SetUpdateMeta(ctx, "1.1.0", "normal", time.Time{})
	if r, _ := s.StagedRelease(ctx); r.Severity != "normal" || !r.Deadline.IsZero() {
		t.Fatalf("cleared: %+v", r)
	}
}
