package pipe

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"offmanual/desk/server-agent/internal/rpc"
)

// fakeAcceptor hands out in-memory connections with a fixed OS identity.
type fakeAcceptor struct {
	conns  chan net.Conn
	caller rpc.Caller
	closed chan struct{}
	fail   error
}

func newFake(c rpc.Caller) *fakeAcceptor {
	return &fakeAcceptor{conns: make(chan net.Conn), caller: c, closed: make(chan struct{})}
}

func (f *fakeAcceptor) Accept() (net.Conn, rpc.Caller, error) {
	if f.fail != nil {
		return nil, rpc.Caller{}, f.fail
	}
	select {
	case c := <-f.conns:
		return c, f.caller, nil
	case <-f.closed:
		return nil, rpc.Caller{}, ErrClosed
	}
}

func (f *fakeAcceptor) Close() error {
	select {
	case <-f.closed:
	default:
		close(f.closed)
	}
	return nil
}

func TestServeDispatchesWithAcceptorIdentity(t *testing.T) {
	who := rpc.Caller{SID: "S-1-5-21-7-7-7-1105", SessionID: 3, PID: 99}
	fa := newFake(who)
	srv := rpc.NewServer(nil)
	srv.Handle("lock.get", func(_ context.Context, c rpc.Caller, _ json.RawMessage) (any, error) {
		return map[string]string{"sid": c.SID}, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, fa, srv, nil) }()

	for i := 0; i < 2; i++ {
		s, c := net.Pipe()
		fa.conns <- s
		_ = c.SetDeadline(time.Now().Add(5 * time.Second))
		_, _ = c.Write([]byte(`{"jsonrpc":"2.0","id":1,"method":"lock.get"}` + "\n"))
		line, err := bufio.NewReader(c).ReadString('\n')
		if err != nil || !strings.Contains(line, who.SID) {
			t.Fatalf("conn %d: %q %v", i, line, err)
		}
		_ = c.Close()
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Serve: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not stop on cancel")
	}
}

func TestServeReturnsAcceptErrors(t *testing.T) {
	fa := newFake(rpc.Caller{})
	fa.fail = errors.New("boom")
	if err := Serve(context.Background(), fa, rpc.NewServer(nil), nil); err == nil || err.Error() != "boom" {
		t.Fatalf("want boom, got %v", err)
	}
}

func TestSDDL(t *testing.T) {
	got := SDDL("S-1-5-18")
	if got != "D:P(A;;GA;;;SY)(A;;GA;;;S-1-5-18)(A;;0x12008b;;;AU)" {
		t.Fatalf("SDDL %s", got)
	}
	if UserAccess&0x4 != 0 {
		t.Fatal("UserAccess includes FILE_CREATE_PIPE_INSTANCE")
	}
}
