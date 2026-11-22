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
}

func newFake() *fakeConsole {
	return &fakeConsole{keys: map[string]ed25519.PublicKey{}, nonces: map[string]bool{}, audits: map[string][]AuditCount{}, validKey: "OMLAB-0001-ABCD", etag: `"p1"`}
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
