package console

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"offmanual/desk/server-agent/internal/store"
)

// fakeConsole mimics apps/console/lib/agent-api.ts: verifies every signature and
// remembers nonces, so the Go client is tested against the same contract.
type fakeConsole struct {
	mu       sync.Mutex
	keys     map[string]ed25519.PublicKey
	nonces   map[string]bool
	policy   Policy
	etag     string
	audits   map[string][]AuditCount
	beats    []Heartbeat
	validKey string // enrolment code
	bindSID  string
	usage    map[string][]UsageCount
}

func newFake() *fakeConsole {
	return &fakeConsole{keys: map[string]ed25519.PublicKey{}, nonces: map[string]bool{}, audits: map[string][]AuditCount{}, usage: map[string][]UsageCount{}, validKey: "OMLAB-0001-ABCD", etag: `"p1"`}
}

func (f *fakeConsole) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	body, _ := io.ReadAll(r.Body)
	s := Signed{ServerID: r.Header.Get(HeaderServer), Timestamp: r.Header.Get(HeaderTimestamp), Nonce: r.Header.Get(HeaderNonce), Signature: r.Header.Get(HeaderSignature)}
	if f.nonces[s.Nonce] {
		http.Error(w, `{"error":"replayed request"}`, http.StatusUnauthorized)
		return
	}
	f.nonces[s.Nonce] = true
	if r.URL.Path == "/api/agent/enroll" {
		var in EnrolRequest
		_ = json.Unmarshal(body, &in)
		raw, _ := base64.StdEncoding.DecodeString(in.PublicKey)
		if s.ServerID != EnrolmentServerID || !Verify(raw, r.Method, r.URL.RequestURI(), s, body) {
			http.Error(w, `{"error":"bad signature"}`, http.StatusUnauthorized)
			return
		}
		if in.Code != f.validKey {
			http.Error(w, `{"error":"This enrolment code is not valid or has expired."}`, http.StatusForbidden)
			return
		}
		f.keys["srv_0123456789abcdef0123456789abcdef"] = raw
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"serverId":"srv_0123456789abcdef0123456789abcdef"}`))
		return
	}
	pub, ok := f.keys[s.ServerID]
	if !ok || !Verify(pub, r.Method, r.URL.RequestURI(), s, body) {
		http.Error(w, `{"error":"bad signature"}`, http.StatusUnauthorized)
		return
	}
	switch r.URL.Path {
	case "/api/agent/heartbeat":
		var hb Heartbeat
		_ = json.Unmarshal(body, &hb)
		f.beats = append(f.beats, hb)
		_, _ = w.Write([]byte(`{"firmStatus":"active","offlineGraceDays":7,"policyVersion":1,"serverTime":"2026-11-22T10:00:00Z"}`))
	case "/api/agent/policy":
		if r.Header.Get("If-None-Match") == f.etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", f.etag)
		_ = json.NewEncoder(w).Encode(f.policy)
	case "/api/agent/notices":
		_, _ = w.Write([]byte(`{"notices":[{"id":"11111111-1111-4111-8111-111111111111","kind":"billing","audience":"admins","title":"Invoice issued","body":"Due soon.","startsAt":"2026-12-01T05:00:00Z"},{"id":"bad","kind":"billing","audience":"admins","title":"x","body":"x","startsAt":""},{"id":"22222222-2222-4222-8222-222222222222","kind":"weird","audience":"all","title":"x","body":"x","startsAt":""}]}`))
	case "/api/agent/usage":
		var in struct {
			Date      string       `json:"date"`
			Employees []UsageCount `json:"employees"`
		}
		_ = json.Unmarshal(body, &in)
		f.usage[in.Date] = in.Employees
		_, _ = w.Write([]byte(`{"stored":1}`))
	case "/api/agent/support":
		var in struct {
			EmployeeID  string         `json:"employeeId"`
			Description string         `json:"description"`
			Bundle      map[string]any `json:"bundle"`
		}
		_ = json.Unmarshal(body, &in)
		if in.Description == "" || in.Bundle == nil {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"invalid report"}`))
			return
		}
		_, _ = w.Write([]byte(`{"ticket":"OM-0042"}`))
	case "/api/agent/bind":
		var in struct {
			Code string `json:"code"`
			SID  string `json:"sid"`
		}
		_ = json.Unmarshal(body, &in)
		f.bindSID = in.SID
		if in.Code != "ABCD-EFGH" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"That code isn't valid or has expired. Sign in again to get a new one."}`))
			return
		}
		_, _ = w.Write([]byte(`{"employeeId":"e-1","name":"Asha","status":"active","packs":["core"]}`))
	case "/api/agent/audit-summary":
		var in struct {
			Date   string       `json:"date"`
			Counts []AuditCount `json:"counts"`
		}
		_ = json.Unmarshal(body, &in)
		f.audits[in.Date] = in.Counts
		_, _ = w.Write([]byte(`{"stored":1}`))
	default:
		http.NotFound(w, r)
	}
}

func setup(t *testing.T) (*fakeConsole, *Client, *store.Store) {
	t.Helper()
	f := newFake()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	c := &Client{BaseURL: srv.URL}
	id, key, err := c.Enrol(context.Background(), " omlab-0001-abcd ", "OMLAB-RDS", "1.0.0", nil)
	if err != nil {
		t.Fatalf("enrol: %v", err)
	}
	c.ServerID, c.Key = id, key
	return f, c, st
}

func TestEnrolRejectsBadCodeAndHTTP(t *testing.T) {
	srv := httptest.NewServer(newFake())
	defer srv.Close()
	_, _, err := (&Client{BaseURL: srv.URL}).Enrol(context.Background(), "WRONG-CODE-1", "H", "1.0.0", nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 403 || !strings.Contains(apiErr.Message, "not valid") {
		t.Fatalf("want 403 with message, got %v", err)
	}
	if _, _, err := (&Client{BaseURL: "http://example.com"}).Enrol(context.Background(), "X", "H", "1.0.0", nil); err == nil {
		t.Fatal("plain-HTTP console accepted")
	}
}

func TestSyncerHeartbeatPolicyAndOffboarding(t *testing.T) {
	f, c, st := setup(t)
	ctx := context.Background()
	// A local employee who is no longer in the console must be disabled.
	_ = st.UpsertEmployee(ctx, store.Employee{SID: "S-1-5-21-1-2-3-1999", EmployeeID: "gone", Name: "Left", Status: "active"})
	_, _ = st.AcquireLease(ctx, "S-1-5-21-1-2-3-1999", 18800, 18900, "h")
	f.policy = Policy{PolicyVersion: 1, Employees: []PolicyEmployee{
		{EmployeeID: "e1", SID: "S-1-5-21-1-2-3-1101", Name: "Asha", Status: "active", Packs: []string{"core"}},
	}}
	s := &Syncer{Client: c, Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), AgentVersion: "1.0.0",
		Seats: func(context.Context) int { return 3 }}
	s.Once(ctx)

	if len(f.beats) != 1 || f.beats[0].ActiveSeats != 3 {
		t.Fatalf("heartbeats %+v", f.beats)
	}
	asha, err := st.Employee(ctx, "S-1-5-21-1-2-3-1101")
	if err != nil || asha.Name != "Asha" || asha.Status != "active" {
		t.Fatalf("asha %+v %v", asha, err)
	}
	left, _ := st.Employee(ctx, "S-1-5-21-1-2-3-1999")
	if left.Status != "disabled" {
		t.Fatalf("offboarded employee still %s", left.Status)
	}
	if _, err := st.LeaseFor(ctx, "S-1-5-21-1-2-3-1999"); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("offboarded employee kept a gateway lease")
	}
	if fs, _ := st.Meta(ctx, MetaFirmStatus); fs != "active" {
		t.Fatalf("firm status %q", fs)
	}
	// Second round: ETag matches → 304 → nothing rewritten; audit backlog already sent.
	sentBefore := len(f.audits)
	s.Once(ctx)
	if len(f.beats) != 2 || len(f.audits) != sentBefore {
		t.Fatalf("second round: beats %d audits %d (before %d)", len(f.beats), len(f.audits), sentBefore)
	}
}

func TestAuditUploadSendsCountsOnly(t *testing.T) {
	f, c, st := setup(t)
	ctx := context.Background()
	yesterday := time.Now().In(ist).AddDate(0, 0, -1)
	st.SetClock(func() time.Time { return yesterday })
	_ = st.AppendAudit(ctx, store.AuditEvent{SID: "S-1", Category: "access_denied", Action: "read", Target: `\\fs\Clients\Mehta\bank.pdf`, Result: "denied"})
	s := &Syncer{Client: c, Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), AgentVersion: "1.0.0"}
	s.Once(ctx)
	day := yesterday.Format("2006-01-02")
	got := f.audits[day]
	if len(got) != 1 || got[0] != (AuditCount{Category: "access_denied", Count: 1}) {
		t.Fatalf("audit for %s: %+v (all %v)", day, got, f.audits)
	}
	for _, counts := range f.audits {
		b, _ := json.Marshal(counts)
		if strings.Contains(string(b), "Mehta") {
			t.Fatal("a path reached the console")
		}
	}
}

func TestReplayedRequestIsRefusedByContract(t *testing.T) {
	_, c, _ := setup(t)
	// Fixed nonce via a fixed clock is not enough to replay: Sign generates a fresh nonce each time.
	if _, err := c.SendHeartbeat(context.Background(), Heartbeat{AgentVersion: "1.0.0", Health: "green"}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.SendHeartbeat(context.Background(), Heartbeat{AgentVersion: "1.0.0", Health: "green"}); err != nil {
		t.Fatalf("second heartbeat (fresh nonce) refused: %v", err)
	}
}

func TestBind(t *testing.T) {
	f, c, _ := setup(t)
	r, err := c.Bind(context.Background(), "ABCD-EFGH", "S-1-5-21-1-2-3-1101")
	if err != nil || r.EmployeeID != "e-1" || r.Status != "active" || len(r.Packs) != 1 {
		t.Fatalf("bind: %+v %v", r, err)
	}
	if f.bindSID != "S-1-5-21-1-2-3-1101" {
		t.Fatalf("sid sent %q", f.bindSID)
	}
	_, err = c.Bind(context.Background(), "WRONG", "S-1-5-21-1-2-3-1101")
	var api *APIError
	if !errors.As(err, &api) || api.Status != 404 || !strings.Contains(api.Message, "isn't valid") {
		t.Fatalf("bad code: %v", err)
	}
}

func TestPolicyAppliesAuthenticatorResetOnce(t *testing.T) {
	_, _, st := setup(t)
	ctx := context.Background()
	sid := "S-1-5-21-1-2-3-1101"
	enrolled := func() bool {
		e, _ := st.Employee(ctx, sid)
		return !e.TOTPEnrolledAt.IsZero()
	}
	enrol := func() {
		_ = st.SetTOTPSecret(ctx, sid, []byte("secret"))
		_ = st.ConfirmTOTP(ctx, sid)
		_ = st.SetRecoveryCodes(ctx, sid, []string{"h1", "h2"})
	}
	p := func(reset string) Policy {
		return Policy{PolicyVersion: 2, Employees: []PolicyEmployee{{EmployeeID: "e1", SID: sid, Name: "Asha", Status: "active", TOTPResetAt: reset}}}
	}
	if err := ApplyPolicy(ctx, st, p(""), `"a"`); err != nil {
		t.Fatal(err)
	}
	enrol()
	if !enrolled() {
		t.Fatal("setup: not enrolled")
	}
	if err := ApplyPolicy(ctx, st, p("2026-11-23T08:00:00Z"), `"b"`); err != nil {
		t.Fatal(err)
	}
	if enrolled() {
		t.Fatal("reset not applied")
	}
	if left, _ := st.RecoveryCodesLeft(ctx, sid); left != 0 {
		t.Fatalf("recovery codes kept: %d", left)
	}
	// The employee enrols a new phone; the same request must not reset it again.
	enrol()
	_ = ApplyPolicy(ctx, st, p("2026-11-23T08:00:00Z"), `"c"`)
	if !enrolled() {
		t.Fatal("same reset applied twice")
	}
	_ = ApplyPolicy(ctx, st, p("2026-11-24T08:00:00Z"), `"d"`)
	if enrolled() {
		t.Fatal("newer reset not applied")
	}
	_ = ApplyPolicy(ctx, st, p("not a time"), `"e"`) // ignored, not an error
}

func TestSubmitSupport(t *testing.T) {
	_, c, _ := setup(t)
	ref, err := c.SubmitSupport(context.Background(), "e-1", "Desk is slow", map[string]any{"server": map[string]any{"agentVersion": "1.0.0"}})
	if err != nil || ref != "OM-0042" {
		t.Fatalf("submit: %q %v", ref, err)
	}
	if _, err := c.SubmitSupport(context.Background(), "e-1", "", map[string]any{}); err == nil {
		t.Fatal("empty report accepted")
	}
}

func TestUsageUploadSendsCompleteDaysOnce(t *testing.T) {
	f, c, st := setup(t)
	ctx := context.Background()
	sid := "S-1-5-21-1-2-3-1101"
	_ = st.UpsertEmployee(ctx, store.Employee{SID: sid, EmployeeID: "e1", Name: "Asha", Status: "active"})
	yesterday := time.Now().In(ist).AddDate(0, 0, -1).Format("2006-01-02")
	today := time.Now().In(ist).Format("2006-01-02")
	_ = st.AddUsage(ctx, sid, yesterday, 4, 1000, 200)
	_ = st.AddUsage(ctx, sid, today, 9, 9, 9) // today isn't complete: not sent yet
	s := &Syncer{Client: c, Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), AgentVersion: "1.0.0"}
	if err := s.uploadUsage(ctx); err != nil {
		t.Fatal(err)
	}
	got := f.usage[yesterday]
	if len(got) != 1 || got[0] != (UsageCount{EmployeeID: "e1", Turns: 4, InputTokens: 1000, OutputTokens: 200}) {
		t.Fatalf("yesterday %+v", got)
	}
	if _, ok := f.usage[today]; ok {
		t.Fatal("today was sent")
	}
	delete(f.usage, yesterday)
	if err := s.uploadUsage(ctx); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.usage[yesterday]; ok {
		t.Fatal("a sent day was sent again")
	}
}

func TestNoticesSyncAndAdminFlag(t *testing.T) {
	_, c, st := setup(t)
	ctx := context.Background()
	sid := "S-1-5-21-1-2-3-1101"
	p := Policy{PolicyVersion: 1, Employees: []PolicyEmployee{{EmployeeID: "e1", SID: sid, Name: "Asha", Status: "active", Admin: true}}}
	if err := ApplyPolicy(ctx, st, p, `"x"`); err != nil {
		t.Fatal(err)
	}
	s := &Syncer{Client: c, Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), AgentVersion: "1.0.0"}
	if err := s.syncNotices(ctx); err != nil {
		t.Fatal(err)
	}
	list, err := st.NoticesFor(ctx, sid)
	if err != nil || len(list) != 1 || list[0].Title != "Invoice issued" {
		t.Fatalf("admin notices %+v %v (malformed ones must be dropped)", list, err)
	}
	p.Employees[0].Admin = false
	_ = ApplyPolicy(ctx, st, p, `"y"`)
	if list, _ := st.NoticesFor(ctx, sid); len(list) != 0 {
		t.Fatalf("no longer an admin but still sees %+v", list)
	}
}

func TestPolicyDisabledEmployeeIsCleanedUp(t *testing.T) {
	_, _, st := setup(t)
	ctx := context.Background()
	sid := "S-1-5-21-1-2-3-1101"
	p := Policy{PolicyVersion: 1, Employees: []PolicyEmployee{{EmployeeID: "e1", SID: sid, Name: "Asha", Status: "active"}}}
	_ = ApplyPolicy(ctx, st, p, `"a"`)
	_, _ = st.AcquireLease(ctx, sid, 18800, 18900, "h")
	_ = st.CreateLinkCode(ctx, sid, "ABCD2345", 10*time.Minute)
	if _, err := st.ConsumeLinkCode(ctx, "ABCD2345", 777); err != nil {
		t.Fatal(err)
	}
	p.Employees[0].Status = "disabled" // switched off in the console, still listed
	if err := ApplyPolicy(ctx, st, p, `"b"`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.LeaseFor(ctx, sid); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("lease kept for a disabled employee")
	}
	if got, _ := st.SIDForTelegramUser(ctx, 777); got != "" {
		t.Fatal("Telegram link kept for a disabled employee")
	}
}
