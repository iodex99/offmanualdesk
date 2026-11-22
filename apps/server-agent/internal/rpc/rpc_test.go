package rpc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"strings"
	"testing"
	"time"
)

type fixture struct {
	client net.Conn
	r      *bufio.Reader
	done   chan error
	logs   *bytes.Buffer
}

func start(t *testing.T, c Caller, register func(s *Server)) *fixture {
	t.Helper()
	logs := &bytes.Buffer{}
	s := NewServer(slog.New(slog.NewJSONHandler(logs, nil)))
	register(s)
	srvConn, cliConn := net.Pipe()
	done := make(chan error, 1)
	go func() { done <- s.ServeConn(context.Background(), srvConn, c) }()
	t.Cleanup(func() { _ = cliConn.Close() })
	return &fixture{client: cliConn, r: bufio.NewReader(cliConn), done: done, logs: logs}
}

func (f *fixture) call(t *testing.T, line string) map[string]any {
	t.Helper()
	_ = f.client.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := f.client.Write([]byte(line + "\n")); err != nil {
		t.Fatal(err)
	}
	out, err := f.r.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("bad response %q: %v", out, err)
	}
	return m
}

func errCode(m map[string]any) int {
	e, _ := m["error"].(map[string]any)
	if e == nil {
		return 0
	}
	return int(e["code"].(float64))
}

var alice = Caller{SID: "S-1-5-21-1-2-3-1001", SessionID: 2, PID: 4242}

func TestCallerComesFromTransportNotBody(t *testing.T) {
	f := start(t, alice, func(s *Server) {
		s.Handle("session.hello", func(_ context.Context, c Caller, p json.RawMessage) (any, error) {
			var in struct {
				Note string `json:"note"`
			}
			if err := DecodeParams(p, &in); err != nil {
				return nil, err
			}
			return map[string]any{"sid": c.SID, "session": c.SessionID}, nil
		})
	})
	m := f.call(t, `{"jsonrpc":"2.0","id":1,"method":"session.hello","params":{"note":"hi"}}`)
	res := m["result"].(map[string]any)
	if res["sid"] != alice.SID || res["session"].(float64) != 2 {
		t.Fatalf("caller not from transport: %v", m)
	}
	// A body that claims another identity is rejected outright (unknown field).
	m = f.call(t, `{"jsonrpc":"2.0","id":2,"method":"session.hello","params":{"sid":"S-1-5-21-9-9-9-500"}}`)
	if errCode(m) != CodeInvalidParams {
		t.Fatalf("identity in params not refused: %v", m)
	}
	m = f.call(t, `{"jsonrpc":"2.0","id":3,"method":"session.hello","sid":"S-1-5-18"}`)
	if errCode(m) != CodeInvalidRequest {
		t.Fatalf("identity in envelope not refused: %v", m)
	}
}

func TestProtocolErrors(t *testing.T) {
	f := start(t, alice, func(s *Server) {
		s.Handle("lock.get", func(context.Context, Caller, json.RawMessage) (any, error) {
			return map[string]bool{"locked": true}, nil
		})
	})
	cases := []struct {
		line string
		code int
	}{
		{`{not json`, CodeParseError},
		{`{"jsonrpc":"1.0","id":1,"method":"lock.get"}`, CodeInvalidRequest},
		{`{"jsonrpc":"2.0","method":"lock.get"}`, CodeInvalidRequest},
		{`{"jsonrpc":"2.0","id":{"x":1},"method":"lock.get"}`, CodeInvalidRequest},
		{`{"jsonrpc":"2.0","id":1.5,"method":"lock.get"}`, CodeInvalidRequest},
		{`{"jsonrpc":"2.0","id":1,"method":"admin.becomeSystem"}`, CodeMethodNotFound},
		{`{"jsonrpc":"2.0","id":1,"method":"lock.get","params":[1,2]}`, CodeInvalidParams},
	}
	for _, c := range cases {
		if got := errCode(f.call(t, c.line)); got != c.code {
			t.Errorf("%s → %d, want %d", c.line, got, c.code)
		}
	}
	ok := f.call(t, `{"jsonrpc":"2.0","id":"abc","method":"lock.get"}`)
	if ok["id"] != "abc" || ok["result"].(map[string]any)["locked"] != true {
		t.Fatalf("string id round trip: %v", ok)
	}
}

func TestErrorsArePlainAndCorrelated(t *testing.T) {
	f := start(t, alice, func(s *Server) {
		s.Handle("auth.verifyPin", func(context.Context, Caller, json.RawMessage) (any, error) {
			return nil, &Error{Code: CodeWrongCode, Message: "That PIN is not right.", Data: map[string]any{"remaining": 2}}
		})
		s.Handle("boom", func(context.Context, Caller, json.RawMessage) (any, error) {
			return nil, errors.New("sql: database is locked at C:\\ProgramData\\OffManual\\agent.db")
		})
		s.Handle("panic", func(context.Context, Caller, json.RawMessage) (any, error) { panic("nil map") })
	})
	m := f.call(t, `{"jsonrpc":"2.0","id":1,"method":"auth.verifyPin","params":{},"correlationId":"desk-0000abcd"}`)
	e := m["error"].(map[string]any)
	data := e["data"].(map[string]any)
	if e["message"] != "That PIN is not right." || data["remaining"].(float64) != 2 || data["correlationId"] != "desk-0000abcd" {
		t.Fatalf("app error: %v", m)
	}
	for _, method := range []string{"boom", "panic"} {
		m = f.call(t, `{"jsonrpc":"2.0","id":2,"method":"`+method+`"}`)
		e = m["error"].(map[string]any)
		if errCode(m) != CodeInternal || strings.Contains(e["message"].(string), "sql") || strings.Contains(e["message"].(string), "ProgramData") {
			t.Fatalf("%s leaked internals: %v", method, m)
		}
		if id, _ := e["data"].(map[string]any)["correlationId"].(string); len(id) < 8 {
			t.Fatalf("%s: no correlation id: %v", method, m)
		}
	}
}

func TestLogsNeverContainParams(t *testing.T) {
	f := start(t, alice, func(s *Server) {
		s.Handle("audit.append", func(context.Context, Caller, json.RawMessage) (any, error) { return nil, nil })
	})
	f.call(t, `{"jsonrpc":"2.0","id":1,"method":"audit.append","params":{"target":"\\\\fs\\Clients\\Mehta Traders\\PAN ABCDE1234F.pdf"}}`)
	if strings.Contains(f.logs.String(), "Mehta") || strings.Contains(f.logs.String(), "ABCDE1234F") {
		t.Fatalf("params leaked into logs: %s", f.logs.String())
	}
	if !strings.Contains(f.logs.String(), `"method":"audit.append"`) {
		t.Fatalf("method not logged: %s", f.logs.String())
	}
}

func TestOversizedMessageClosesConnection(t *testing.T) {
	f := start(t, alice, func(*Server) {})
	big := `{"jsonrpc":"2.0","id":1,"method":"x","params":{"p":"` + strings.Repeat("a", MaxMessageBytes) + `"}}`
	go func() { _, _ = f.client.Write([]byte(big + "\n")) }()
	_ = f.client.SetDeadline(time.Now().Add(5 * time.Second))
	out, _ := f.r.ReadBytes('\n')
	if !bytes.Contains(out, []byte(`"code":-32600`)) {
		t.Fatalf("no invalid-request reply: %q", out)
	}
	select {
	case err := <-f.done:
		if !errors.Is(err, errTooLong) {
			t.Fatalf("serve ended with %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("connection not closed")
	}
}

func TestBlankLinesIgnoredAndCleanEOF(t *testing.T) {
	f := start(t, alice, func(s *Server) {
		s.Handle("lock.get", func(context.Context, Caller, json.RawMessage) (any, error) { return nil, nil })
	})
	_, _ = f.client.Write([]byte("\n\n"))
	m := f.call(t, `{"jsonrpc":"2.0","id":7,"method":"lock.get"}`)
	if m["id"].(float64) != 7 {
		t.Fatalf("unexpected %v", m)
	}
	_ = f.client.Close()
	if err := <-f.done; err != nil {
		t.Fatalf("clean EOF returned %v", err)
	}
}

func TestDuplicateHandlerPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("duplicate registration did not panic")
		}
	}()
	s := NewServer(nil)
	s.Handle("x", nil)
	s.Handle("x", nil)
}

func TestContextCancelStopsServe(t *testing.T) {
	s := NewServer(nil)
	srv, cli := net.Pipe()
	defer func() { _ = cli.Close() }()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.ServeConn(ctx, srv, alice) }()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("ServeConn: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ServeConn ignored cancellation")
	}
}
