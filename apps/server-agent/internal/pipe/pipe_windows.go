//go:build windows

package pipe

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"

	"offmanual/desk/server-agent/internal/rpc"
)

// Listener is a Windows named-pipe Acceptor. go-winio creates the first instance
// with FILE_CREATE (fails if anyone already owns the name, like
// FILE_FLAG_FIRST_PIPE_INSTANCE) and always sets FILE_PIPE_REJECT_REMOTE_CLIENTS.
type Listener struct {
	l net.Listener
}

// Listen creates the pipe with the ADR-029 DACL. The owner (the account running
// the service) is read from this process's token.
func Listen(name string) (*Listener, error) {
	owner, err := currentUserSID()
	if err != nil {
		return nil, err
	}
	l, err := winio.ListenPipe(name, &winio.PipeConfig{
		SecurityDescriptor: SDDL(owner),
		InputBufferSize:    64 * 1024,
		OutputBufferSize:   64 * 1024,
	})
	if err != nil {
		return nil, fmt.Errorf("listen %s: %w", name, err)
	}
	return &Listener{l: l}, nil
}

// Accept waits for a client and identifies it from its process token.
func (p *Listener) Accept() (net.Conn, rpc.Caller, error) {
	conn, err := p.l.Accept()
	if err != nil {
		if errors.Is(err, net.ErrClosed) {
			return nil, rpc.Caller{}, ErrClosed
		}
		return nil, rpc.Caller{}, err
	}
	caller, err := ClientIdentity(conn)
	if err != nil {
		_ = conn.Close()
		// Fail closed: a client we can't identify gets nothing. Keep accepting.
		return p.Accept()
	}
	return conn, caller, nil
}

// Close stops accepting.
func (p *Listener) Close() error { return p.l.Close() }

type fdConn interface{ Fd() uintptr }

// ClientIdentity returns the SID, session and PID of the process at the client end.
// It uses the client's process token (not impersonation), which also works when the
// client connects at SECURITY_ANONYMOUS (lab L7).
func ClientIdentity(conn net.Conn) (rpc.Caller, error) {
	fc, ok := conn.(fdConn)
	if !ok {
		return rpc.Caller{}, errors.New("not a pipe connection")
	}
	var pid uint32
	if err := windows.GetNamedPipeClientProcessId(windows.Handle(fc.Fd()), &pid); err != nil {
		return rpc.Caller{}, fmt.Errorf("GetNamedPipeClientProcessId: %w", err)
	}
	sid, session, err := processIdentity(pid)
	if err != nil {
		return rpc.Caller{}, err
	}
	return rpc.Caller{SID: sid, SessionID: session, PID: pid}, nil
}

// ServerSID returns the user SID of the process serving a pipe the caller dialled.
// Clients must check it is S-1-5-18 (LocalSystem) before sending secrets (ADR-029).
func ServerSID(conn net.Conn) (string, error) {
	fc, ok := conn.(fdConn)
	if !ok {
		return "", errors.New("not a pipe connection")
	}
	var pid uint32
	if err := windows.GetNamedPipeServerProcessId(windows.Handle(fc.Fd()), &pid); err != nil {
		return "", fmt.Errorf("GetNamedPipeServerProcessId: %w", err)
	}
	sid, _, err := processIdentity(pid)
	return sid, err
}

// Dial connects with exactly UserAccess (read + write-data). Standard clients ask
// for GENERIC_WRITE, which includes FILE_CREATE_PIPE_INSTANCE and is therefore
// refused by the ADR-029 DACL; every Off Manual client must request UserAccess
// (Desk via CreateFileW, Node via `server-agent bridge`). go-winio dials at
// SECURITY_ANONYMOUS, so the server can never impersonate the client.
func Dial(ctx context.Context, name string) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return winio.DialPipeAccess(ctx, name, UserAccess)
}

// LocalSystemSID is the only acceptable server identity in production.
const LocalSystemSID = "S-1-5-18"

// Bridge relays in → pipe and pipe → out after checking the server's identity
// (ADR-034). It returns when either side closes. wantServerSID "" means LocalSystem.
func Bridge(ctx context.Context, name, wantServerSID string, in io.Reader, out io.Writer) error {
	if wantServerSID == "" {
		wantServerSID = LocalSystemSID
	}
	conn, err := Dial(ctx, name)
	if err != nil {
		return fmt.Errorf("connect to Off Manual Server Agent: %w", err)
	}
	defer func() { _ = conn.Close() }()
	got, err := ServerSID(conn)
	if err != nil {
		return err
	}
	if got != wantServerSID {
		return fmt.Errorf("refusing to talk to %s: the pipe is served by %s, not %s", name, got, wantServerSID)
	}
	// Count newline-terminated requests and replies so that when the input ends
	// (one-shot use) we still deliver every outstanding reply before closing.
	sent, recv := &lineCounter{}, &lineCounter{}
	inDone := make(chan error, 1)
	outDone := make(chan error, 1)
	go func() { _, err := io.Copy(io.MultiWriter(conn, sent), in); inDone <- err }()
	go func() { _, err := io.Copy(io.MultiWriter(out, recv), conn); outDone <- err }()
	select {
	case err := <-outDone: // server closed
		return quiet(err)
	case <-ctx.Done():
		return nil
	case err := <-inDone:
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		deadline := time.After(10 * time.Second)
		for recv.n.Load() < sent.n.Load() {
			select {
			case err := <-outDone:
				return quiet(err)
			case <-deadline:
				return errors.New("timed out waiting for the Server Agent's reply")
			case <-ctx.Done():
				return nil
			case <-time.After(10 * time.Millisecond):
			}
		}
		return nil
	}
}

func processIdentity(pid uint32) (string, uint32, error) {
	var session uint32
	if err := windows.ProcessIdToSessionId(pid, &session); err != nil {
		return "", 0, fmt.Errorf("ProcessIdToSessionId: %w", err)
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", 0, fmt.Errorf("OpenProcess: %w", err)
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var tok windows.Token
	if err := windows.OpenProcessToken(h, windows.TOKEN_QUERY, &tok); err != nil {
		return "", 0, fmt.Errorf("OpenProcessToken: %w", err)
	}
	defer func() { _ = tok.Close() }()
	u, err := tok.GetTokenUser()
	if err != nil {
		return "", 0, fmt.Errorf("GetTokenUser: %w", err)
	}
	return u.User.Sid.String(), session, nil
}

func currentUserSID() (string, error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", fmt.Errorf("current token user: %w", err)
	}
	return u.User.Sid.String(), nil
}

func quiet(err error) error {
	if err == nil || errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}
