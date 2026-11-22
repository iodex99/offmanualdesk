package gateway

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeGateway re-implements the server-side checks from OpenClaw's source
// (handshake-auth-helpers.ts resolveDeviceSignaturePayloadVersion,
// device-identity.ts deriveDeviceIdFromPublicKey) so the client is tested
// against the real rules, not against itself.
type fakeGateway struct {
	token   string
	nonce   string
	ts      int64
	replies []map[string]any // chat events after chat.send
}

func (g *fakeGateway) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = ws.CloseNow() }()
		ctx := r.Context()
		send := func(v any) { b, _ := json.Marshal(v); _ = ws.Write(ctx, websocket.MessageText, b) }
		send(map[string]any{"type": "event", "event": "connect.challenge", "payload": map[string]any{"nonce": g.nonce, "ts": g.ts}})
		for {
			_, b, err := ws.Read(ctx)
			if err != nil {
				return
			}
			var req struct {
				ID     string          `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			_ = json.Unmarshal(b, &req)
			switch req.Method {
			case "connect":
				var p struct {
					MinProtocol int `json:"minProtocol"`
					Client      struct {
						ID, Version, Platform, Mode, DeviceFamily string
					} `json:"client"`
					Role   string   `json:"role"`
					Scopes []string `json:"scopes"`
					Auth   struct {
						Token string `json:"token"`
					} `json:"auth"`
					Device struct {
						ID, PublicKey, Signature, Nonce string
						SignedAt                        int64
					} `json:"device"`
				}
				_ = json.Unmarshal(req.Params, &p)
				raw, _ := base64.RawURLEncoding.DecodeString(p.Device.PublicKey)
				sum := sha256.Sum256(raw)
				sig, _ := base64.RawURLEncoding.DecodeString(p.Device.Signature)
				payload := strings.Join([]string{"v3", p.Device.ID, p.Client.ID, p.Client.Mode, p.Role, strings.Join(p.Scopes, ","),
					strconv.FormatInt(p.Device.SignedAt, 10), p.Auth.Token, p.Device.Nonce, strings.ToLower(p.Client.Platform), strings.ToLower(p.Client.DeviceFamily)}, "|")
				ok := p.MinProtocol == 4 && p.Auth.Token == g.token && p.Device.Nonce == g.nonce && p.Device.SignedAt == g.ts &&
					len(raw) == ed25519.PublicKeySize && hex.EncodeToString(sum[:]) == p.Device.ID &&
					ed25519.Verify(raw, []byte(payload), sig) && p.Client.ID == "gateway-client"
				if !ok {
					send(map[string]any{"type": "res", "id": req.ID, "ok": false, "error": map[string]any{"code": "UNAUTHORIZED"}})
					continue
				}
				send(map[string]any{"type": "res", "id": req.ID, "ok": true, "payload": map[string]any{"type": "hello-ok", "protocol": 4}})
			case "chat.send":
				var p struct {
					SessionKey, Message, IdempotencyKey string
				}
				_ = json.Unmarshal(req.Params, &p)
				if p.IdempotencyKey == "" || p.SessionKey == "" {
					send(map[string]any{"type": "res", "id": req.ID, "ok": false, "error": map[string]any{"code": "INVALID"}})
					continue
				}
				send(map[string]any{"type": "event", "event": "tick", "payload": map[string]any{}})
				send(map[string]any{"type": "res", "id": req.ID, "ok": true, "payload": map[string]any{"runId": "run-1", "status": "started"}})
				send(map[string]any{"type": "event", "event": "chat", "payload": map[string]any{"runId": "other", "state": "delta", "deltaText": "NOT MINE"}})
				for _, ev := range g.replies {
					send(map[string]any{"type": "event", "event": "chat", "payload": ev})
				}
			case "chat.abort":
				send(map[string]any{"type": "res", "id": req.ID, "ok": true, "payload": map[string]any{}})
			}
		}
	}
}

func start(t *testing.T, g *fakeGateway) int {
	t.Helper()
	srv := httptest.NewServer(g.handler(t))
	t.Cleanup(srv.Close)
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	p, _ := strconv.Atoi(port)
	return p
}

func dial(t *testing.T, port int, token string) (*Client, error) {
	d, err := NewDevice()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return Dial(ctx, Options{Port: port, Token: token, Device: d, Version: "1.0.0", Platform: "Windows"})
}

func TestHandshakeAndChat(t *testing.T) {
	g := &fakeGateway{token: "tok-123", nonce: "n-abc", ts: 1795300000123, replies: []map[string]any{
		{"runId": "run-1", "state": "status", "phase": "starting_model"},
		{"runId": "run-1", "state": "delta", "deltaText": "Hel"},
		{"runId": "run-1", "state": "delta", "deltaText": "lo"},
		{"runId": "run-1", "state": "delta", "deltaText": "Hello, Asha.", "replace": true},
		{"runId": "run-1", "state": "final"},
	}}
	c, err := dial(t, start(t, g), "tok-123")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = c.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	reply, err := c.Chat(ctx, "agent:main:telegram:42", "Which clients are pending?")
	if err != nil || reply != "Hello, Asha." {
		t.Fatalf("reply %q err %v", reply, err)
	}
	if err := c.Abort(ctx, "agent:main:telegram:42", "run-1"); err != nil {
		t.Fatal(err)
	}
}

func TestWrongTokenIsRefused(t *testing.T) {
	g := &fakeGateway{token: "right", nonce: "n", ts: 1}
	if _, err := dial(t, start(t, g), "wrong"); !errors.Is(err, ErrAuth) {
		t.Fatalf("want ErrAuth, got %v", err)
	}
}

func TestRunErrorsAndAborts(t *testing.T) {
	for _, tc := range []struct {
		state string
		want  error
	}{{"error", ErrRun}, {"aborted", ErrAborted}} {
		g := &fakeGateway{token: "t", nonce: "n", ts: 1, replies: []map[string]any{
			{"runId": "run-1", "state": tc.state, "errorMessage": "model unavailable"},
		}}
		c, err := dial(t, start(t, g), "t")
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, err = c.Chat(ctx, "agent:main:main", "hi")
		cancel()
		_ = c.Close()
		if !errors.Is(err, tc.want) {
			t.Fatalf("%s: want %v, got %v", tc.state, tc.want, err)
		}
	}
}

func TestPayloadV3AndDeviceID(t *testing.T) {
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	d := Device{Key: ed25519.NewKeyFromSeed(seed)}
	sum := sha256.Sum256(d.pub())
	if d.ID() != hex.EncodeToString(sum[:]) || len(d.ID()) != 64 {
		t.Fatalf("device id %s", d.ID())
	}
	if strings.ContainsAny(d.PublicKey(), "+/=") {
		t.Fatal("public key must be base64url without padding")
	}
	got := PayloadV3("dev", "gateway-client", "backend", "operator", []string{"operator.read", "operator.write"}, 123, "tok", "non", " Windows ", "")
	want := "v3|dev|gateway-client|backend|operator|operator.read,operator.write|123|tok|non|windows|"
	if got != want {
		t.Fatalf("payload\n%q\nwant\n%q", got, want)
	}
}

func TestDialRejectsBadOptions(t *testing.T) {
	if _, err := Dial(context.Background(), Options{Port: 0}); err == nil {
		t.Fatal("bad options accepted")
	}
}
