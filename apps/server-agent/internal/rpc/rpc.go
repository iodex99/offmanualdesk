// Package rpc implements the Server Agent's newline-delimited JSON-RPC 2.0 protocol
// (docs/ARCHITECTURE.md §3.1, packages/shared-schema/schemas/ipc/envelope.schema.json).
//
// Identity rule (BUILD_PROMPT §3 rule 4): the transport supplies the Caller from the
// operating system (pipe client process token → SID, session ID). Handlers receive
// it as an argument; nothing in a message body is ever used as identity, and the
// envelope rejects unknown top-level fields.
//
// Logging: method, correlation ID, duration and error code only. Params and results
// are never logged (SECURITY.md §4).
package rpc

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"sync"
	"time"
)

// MaxMessageBytes bounds one request line.
const MaxMessageBytes = 64 * 1024

// Standard and application error codes.
const (
	CodeParseError     = -32700
	CodeInvalidRequest = -32600
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeInternal       = -32603

	CodeUnauthorized = -32001 // caller not allowed (unknown SID, disabled, wrong process)
	CodeLocked       = -32002 // locked / lockout in force
	CodeWrongCode    = -32003 // wrong PIN/TOTP (data.remaining etc.)
	CodeConflict     = -32004 // state conflict (e.g. no free port)
	CodeUnavailable  = -32005 // dependency down; retry later
)

// Caller is the OS-derived identity of the process at the other end.
type Caller struct {
	SID       string // e.g. S-1-5-21-…; from the client process token
	SessionID uint32 // Windows session of the client process
	PID       uint32
}

// Error is a JSON-RPC error. Message must be plain, client-safe text.
type Error struct {
	Code    int            `json:"code"`
	Message string         `json:"message"`
	Data    map[string]any `json:"data,omitempty"`
}

func (e *Error) Error() string { return fmt.Sprintf("rpc error %d: %s", e.Code, e.Message) }

// Errorf builds an *Error.
func Errorf(code int, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Handler serves one method. params is the raw "params" object (or nil).
type Handler func(ctx context.Context, c Caller, params json.RawMessage) (any, error)

type request struct {
	JSONRPC       string          `json:"jsonrpc"`
	ID            json.RawMessage `json:"id"`
	Method        string          `json:"method"`
	Params        json.RawMessage `json:"params,omitempty"`
	CorrelationID string          `json:"correlationId,omitempty"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

var correlationRe = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)

// Server dispatches requests to registered handlers.
type Server struct {
	mu       sync.RWMutex
	handlers map[string]Handler
	log      *slog.Logger
}

// NewServer creates an empty server.
func NewServer(log *slog.Logger) *Server {
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Server{handlers: map[string]Handler{}, log: log}
}

// Handle registers a handler. Registering a name twice panics (programming error).
func (s *Server) Handle(method string, h Handler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, dup := s.handlers[method]; dup {
		panic("rpc: duplicate handler " + method)
	}
	s.handlers[method] = h
}

// Methods lists registered method names (tests compare against the shared schema).
func (s *Server) Methods() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(s.handlers))
	for m := range s.handlers {
		out = append(out, m)
	}
	return out
}

// ServeConn reads requests from conn until EOF, error or ctx cancellation, and
// writes one response line per request. Requests are handled in order.
func (s *Server) ServeConn(ctx context.Context, conn io.ReadWriteCloser, c Caller) error {
	defer func() { _ = conn.Close() }()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()

	r := bufio.NewReaderSize(conn, 4096)
	w := bufio.NewWriter(conn)
	for {
		line, err := readLine(r)
		if errors.Is(err, io.EOF) || ctx.Err() != nil {
			return nil
		}
		if errors.Is(err, errTooLong) {
			_ = writeResponse(w, response{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: Errorf(CodeInvalidRequest, "message too large")})
			return err
		}
		if err != nil {
			return err
		}
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		resp := s.dispatch(ctx, c, line)
		if err := writeResponse(w, resp); err != nil {
			return err
		}
	}
}

var errTooLong = errors.New("rpc message too long")

func readLine(r *bufio.Reader) ([]byte, error) {
	var buf []byte
	for {
		chunk, isPrefix, err := r.ReadLine()
		if err != nil {
			if len(buf) > 0 && errors.Is(err, io.EOF) {
				return buf, nil
			}
			return nil, err
		}
		buf = append(buf, chunk...)
		if len(buf) > MaxMessageBytes {
			return nil, errTooLong
		}
		if !isPrefix {
			return buf, nil
		}
	}
}

func writeResponse(w *bufio.Writer, resp response) error {
	b, err := json.Marshal(resp)
	if err != nil {
		b, _ = json.Marshal(response{JSONRPC: "2.0", ID: resp.ID, Error: Errorf(CodeInternal, "internal error")})
	}
	if _, err := w.Write(append(b, '\n')); err != nil {
		return err
	}
	return w.Flush()
}

func (s *Server) dispatch(ctx context.Context, c Caller, line []byte) response {
	nullID := json.RawMessage("null")
	var req request
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		var syn *json.SyntaxError
		if errors.As(err, &syn) || errors.Is(err, io.ErrUnexpectedEOF) {
			return response{JSONRPC: "2.0", ID: nullID, Error: Errorf(CodeParseError, "parse error")}
		}
		return response{JSONRPC: "2.0", ID: nullID, Error: Errorf(CodeInvalidRequest, "invalid request")}
	}
	id := req.ID
	if !validID(id) {
		return response{JSONRPC: "2.0", ID: nullID, Error: Errorf(CodeInvalidRequest, "invalid request id")}
	}
	if req.JSONRPC != "2.0" || req.Method == "" {
		return response{JSONRPC: "2.0", ID: id, Error: Errorf(CodeInvalidRequest, "invalid request")}
	}
	if len(req.Params) > 0 && !bytes.HasPrefix(bytes.TrimSpace(req.Params), []byte("{")) {
		return response{JSONRPC: "2.0", ID: id, Error: Errorf(CodeInvalidParams, "params must be an object")}
	}
	corr := req.CorrelationID
	if corr == "" || !correlationRe.MatchString(corr) {
		corr = newCorrelationID()
	}

	s.mu.RLock()
	h, ok := s.handlers[req.Method]
	s.mu.RUnlock()
	if !ok {
		s.log.Warn("rpc unknown method", "correlation_id", corr, "pid", c.PID)
		return response{JSONRPC: "2.0", ID: id, Error: Errorf(CodeMethodNotFound, "method not found")}
	}

	start := time.Now()
	result, err := safeCall(ctx, h, c, req.Params)
	attrs := []any{"method", req.Method, "correlation_id", corr, "session", c.SessionID, "duration_ms", time.Since(start).Milliseconds()}
	if err != nil {
		var re *Error
		if !errors.As(err, &re) {
			s.log.Error("rpc handler failed", append(attrs, "error", err.Error())...)
			re = Errorf(CodeInternal, "Something went wrong on the server. Try again; if it keeps happening, use Report a problem.")
		} else {
			s.log.Info("rpc refused", append(attrs, "code", re.Code)...)
		}
		if re.Data == nil {
			re.Data = map[string]any{}
		}
		re.Data["correlationId"] = corr
		return response{JSONRPC: "2.0", ID: id, Error: re}
	}
	s.log.Info("rpc ok", attrs...)
	if result == nil {
		result = struct{}{}
	}
	return response{JSONRPC: "2.0", ID: id, Result: result}
}

func safeCall(ctx context.Context, h Handler, c Caller, params json.RawMessage) (result any, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("handler panic: %v", p)
		}
	}()
	return h(ctx, c, params)
}

func validID(id json.RawMessage) bool {
	if len(id) == 0 {
		return false
	}
	var v any
	if err := json.Unmarshal(id, &v); err != nil {
		return false
	}
	switch x := v.(type) {
	case string:
		return len(x) <= 64
	case float64:
		return x == float64(int64(x))
	default:
		return false
	}
}

func newCorrelationID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "corr-unavailable"
	}
	return hex.EncodeToString(b)
}

// DecodeParams strictly decodes params into dst (unknown fields rejected) and
// returns an InvalidParams error on failure.
func DecodeParams(params json.RawMessage, dst any) error {
	if len(params) == 0 {
		params = json.RawMessage("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(params))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return Errorf(CodeInvalidParams, "invalid params")
	}
	return nil
}
