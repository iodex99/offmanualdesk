// Package pipe serves the rpc protocol on \\.\pipe\offmanual-agent (ADR-029).
//
// The Windows listener (pipe_windows.go) derives each caller from the OS:
// GetNamedPipeClientProcessId → process token → user SID, plus the Windows session.
// Other platforms get no listener; tests there use Serve with a fake Acceptor.
package pipe

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"

	"offmanual/desk/server-agent/internal/rpc"
)

// Name is the production pipe path.
const Name = `\\.\pipe\offmanual-agent`

// UserAccess is the access mask granted to Authenticated Users:
// FILE_GENERIC_READ (0x120089) | FILE_WRITE_DATA (0x2). It deliberately excludes
// FILE_CREATE_PIPE_INSTANCE (= FILE_APPEND_DATA, 0x4), so users can't squat the pipe
// (lab L7 self-test; Microsoft Learn "Named Pipe Security and Access Rights").
const UserAccess = 0x0012008B

// SDDL builds the pipe's DACL: SYSTEM and the owning account (SYSTEM in production)
// full control; Authenticated Users read + write-data only; no anonymous access.
func SDDL(ownerSID string) string {
	return "D:P(A;;GA;;;SY)(A;;GA;;;" + ownerSID + ")(A;;0x12008b;;;AU)"
}

// Acceptor yields connections with their OS-derived caller identity.
type Acceptor interface {
	Accept() (net.Conn, rpc.Caller, error)
	Close() error
}

// ErrClosed is returned by Accept after Close.
var ErrClosed = errors.New("pipe listener closed")

// Serve accepts connections until ctx is cancelled or the acceptor fails, serving
// each on its own goroutine. It closes the acceptor and waits for connections.
func Serve(ctx context.Context, a Acceptor, srv *rpc.Server, log *slog.Logger) error {
	if log == nil {
		log = slog.Default()
	}
	stop := context.AfterFunc(ctx, func() { _ = a.Close() })
	defer stop()
	var wg sync.WaitGroup
	defer wg.Wait()
	for {
		conn, caller, err := a.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, ErrClosed) || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := srv.ServeConn(ctx, conn, caller); err != nil {
				log.Warn("pipe connection ended with error", "session", caller.SessionID, "pid", caller.PID, "error", err.Error())
			}
		}()
	}
}

// lineCounter counts newline-terminated lines that contain something other than
// whitespace. The server ignores blank lines and sends no reply for them, so the
// bridge must not wait for one (CI: PowerShell appends a trailing blank line).
type lineCounter struct {
	mu      sync.Mutex
	content bool
	n       atomic.Int64
}

func (c *lineCounter) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, b := range p {
		switch b {
		case '\n':
			if c.content {
				c.n.Add(1)
			}
			c.content = false
		case ' ', '\t', '\r':
		default:
			c.content = true
		}
	}
	return len(p), nil
}
