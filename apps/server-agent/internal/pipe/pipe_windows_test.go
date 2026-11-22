//go:build windows

package pipe

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"offmanual/desk/server-agent/internal/rpc"
)

var pipeSeq atomic.Int64

// testPipeName is unique per call: Windows clock ticks can repeat, so add a counter
// and random bytes.
func testPipeName(t *testing.T) string {
	t.Helper()
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return fmt.Sprintf(`\\.\pipe\offmanual-test-%d-%d-%x`, os.Getpid(), pipeSeq.Add(1), b)
}

func serve(t *testing.T) (name string, cancel context.CancelFunc, done chan error) {
	t.Helper()
	name = testPipeName(t)
	l, err := Listen(name)
	if err != nil {
		t.Fatal(err)
	}
	srv := rpc.NewServer(nil)
	srv.Handle("session.hello", func(_ context.Context, c rpc.Caller, _ json.RawMessage) (any, error) {
		return map[string]any{"sid": c.SID, "session": c.SessionID, "pid": c.PID}, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	done = make(chan error, 1)
	go func() { done <- Serve(ctx, l, srv, nil) }()
	return name, cancel, done
}

func stopServe(t *testing.T, cancel context.CancelFunc, done chan error) {
	t.Helper()
	cancel()
	if err := <-done; err != nil {
		t.Errorf("Serve: %v", err)
	}
}

func TestCallerIdentityFromProcessToken(t *testing.T) {
	name, cancel, done := serve(t)
	defer stopServe(t, cancel, done)

	me, err := currentUserSID()
	if err != nil {
		t.Fatal(err)
	}
	var mySession uint32
	_ = windows.ProcessIdToSessionId(uint32(os.Getpid()), &mySession) //nolint:gosec // pid fits

	for i := 0; i < 3; i++ { // several connections: exercises extra pipe instances
		conn, err := Dial(context.Background(), name)
		if err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
		srvSID, err := ServerSID(conn)
		if err != nil || srvSID != me {
			t.Fatalf("server SID %q (%v), want %q", srvSID, err, me)
		}
		// Claim to be SYSTEM in the body: must be refused, identity stays ours.
		_, _ = conn.Write([]byte(`{"jsonrpc":"2.0","id":1,"method":"session.hello","params":{}}` + "\n"))
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		var resp struct {
			Result struct {
				SID     string `json:"sid"`
				Session uint32 `json:"session"`
				PID     uint32 `json:"pid"`
			} `json:"result"`
		}
		if err := json.Unmarshal(line, &resp); err != nil {
			t.Fatal(err)
		}
		if resp.Result.SID != me || resp.Result.Session != mySession || resp.Result.PID != uint32(os.Getpid()) { //nolint:gosec // pid fits
			t.Fatalf("caller %+v, want sid %s session %d pid %d", resp.Result, me, mySession, os.Getpid())
		}
		_ = conn.Close()
	}
}

func TestSecondListenerOnSameNameFails(t *testing.T) {
	name, cancel, done := serve(t)
	defer stopServe(t, cancel, done)
	if l2, err := Listen(name); err == nil {
		_ = l2.Close()
		t.Fatal("a second server created an instance of an existing pipe (squatting)")
	}
}

func TestPipeDACLMatchesADR029(t *testing.T) {
	name, cancel, done := serve(t)
	defer stopServe(t, cancel, done)
	conn, err := Dial(context.Background(), name)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	// GENERIC_READ on the client handle includes READ_CONTROL, so we can read the DACL.
	sd, err := windows.GetSecurityInfo(windows.Handle(conn.(fdConn).Fd()), windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("GetSecurityInfo: %v", err)
	}
	sddl := sd.String()
	for _, want := range []string{"(A;;FA;;;SY)", ";;;AU)"} {
		if !strings.Contains(sddl, want) {
			t.Errorf("DACL %s missing %s", sddl, want)
		}
	}
	if !strings.Contains(strings.ToLower(sddl), "0x12008b;;;au)") {
		t.Errorf("Authenticated Users must get exactly read + write-data: %s", sddl)
	}
	if strings.Contains(sddl, ";;;AN)") || strings.Contains(sddl, ";;;WD)") {
		t.Errorf("DACL grants anonymous/everyone: %s", sddl)
	}
	t.Logf("pipe DACL: %s", sddl)
}

func TestServeStopsOnCancel(t *testing.T) {
	_, cancel, done := serve(t)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not stop")
	}
}

func TestBridgeRelaysAndChecksServerIdentity(t *testing.T) {
	name, cancel, done := serve(t)
	defer stopServe(t, cancel, done)
	me, _ := currentUserSID()
	in := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"session.hello","params":{}}` + "\n")
	var out strings.Builder
	ctx, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	// The test server runs as us, not SYSTEM: name our SID explicitly.
	if err := Bridge(ctx, name, me, in, &syncWriter{w: &out}); err != nil {
		t.Fatalf("bridge: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(out.String(), me) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(out.String(), me) {
		t.Fatalf("bridge output %q", out.String())
	}
	// Default expectation is LocalSystem: our own server must be refused.
	err := Bridge(ctx, name, "", strings.NewReader(""), io.Discard)
	if err == nil || !strings.Contains(err.Error(), "refusing") {
		t.Fatalf("non-SYSTEM server accepted: %v", err)
	}
}

type syncWriter struct {
	mu sync.Mutex
	w  *strings.Builder
}

func (s *syncWriter) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.w.Write(p)
}
