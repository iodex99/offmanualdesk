// Package gateway is a minimal OpenClaw gateway client (protocol v4) used by the
// Server Agent's Telegram relay (ADR-023) and as the reference for Desk's Rust client
// (ADR-021). Every wire detail is from OpenClaw 2026.11.6 source (docs/OPENCLAW_NOTES.md §3):
//
//   - transport: WebSocket ws://127.0.0.1:<port>, JSON text frames
//     req {type:"req",id,method,params} / res {type:"res",id,ok,payload,error} /
//     event {type:"event",event,payload}
//   - handshake: server sends event "connect.challenge" {nonce, ts}; client sends
//     req "connect" {minProtocol:4, maxProtocol:4, client{id,version,platform,mode},
//     role, scopes, caps, auth{token}, device{id,publicKey,signature,signedAt,nonce}};
//     server answers res payload {type:"hello-ok", ...}
//   - device id = hex(sha256(raw ed25519 public key)); publicKey and signature are
//     base64url (no padding); signature is over the UTF-8 "v3" payload
//     (packages/gateway-client/src/device-auth.ts buildDeviceAuthPayloadV3)
//   - chat: req "chat.send" {sessionKey, message, idempotencyKey} → res {runId};
//     events "chat" {runId, state: status|delta|final|aborted|error, deltaText, replace?}
package gateway

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// Protocol constants.
const (
	ProtocolVersion = 4
	ClientID        = "gateway-client" // closed enum in gateway-protocol client-info.ts
	ClientMode      = "backend"
	Role            = "operator"
)

// DefaultScopes are what the relay needs: read, write (chat), approvals.
var DefaultScopes = []string{"operator.read", "operator.write"}

// Device is an Ed25519 device identity.
type Device struct{ Key ed25519.PrivateKey }

// NewDevice generates a fresh identity.
func NewDevice() (Device, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	return Device{Key: priv}, err
}

func (d Device) pub() ed25519.PublicKey { return d.Key.Public().(ed25519.PublicKey) }

// ID is hex(sha256(raw public key)) (src/infra/device-identity.ts deriveDeviceIdFromPublicKey).
func (d Device) ID() string {
	sum := sha256.Sum256(d.pub())
	return hex.EncodeToString(sum[:])
}

// PublicKey is the raw key in base64url without padding.
func (d Device) PublicKey() string { return base64.RawURLEncoding.EncodeToString(d.pub()) }

// normalizeMeta lower-cases ASCII A–Z after trimming (device-auth.ts normalizeDeviceMetadataForAuth).
func normalizeMeta(s string) string {
	s = strings.TrimSpace(s)
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// PayloadV3 builds the exact string the gateway verifies.
func PayloadV3(deviceID, clientID, clientMode, role string, scopes []string, signedAtMs int64, token, nonce, platform, deviceFamily string) string {
	return strings.Join([]string{
		"v3", deviceID, clientID, clientMode, role, strings.Join(scopes, ","),
		strconv.FormatInt(signedAtMs, 10), token, nonce, normalizeMeta(platform), normalizeMeta(deviceFamily),
	}, "|")
}

// Sign signs a payload, returning base64url without padding.
func (d Device) Sign(payload string) string {
	return base64.RawURLEncoding.EncodeToString(ed25519.Sign(d.Key, []byte(payload)))
}

type frame struct {
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  any             `json:"params,omitempty"`
	OK      *bool           `json:"ok,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Error   json.RawMessage `json:"error,omitempty"`
	Event   string          `json:"event,omitempty"`
}

// Client is one authenticated gateway connection.
type Client struct {
	ws    *websocket.Conn
	seq   atomic.Int64
	Hello json.RawMessage
}

// ErrAuth means the gateway refused the token or device signature.
var ErrAuth = errors.New("gateway refused authentication")

// Options for Dial.
type Options struct {
	Port     int
	Token    string
	Device   Device
	Version  string
	Platform string
	Scopes   []string
}

// Dial connects and completes the v4 handshake.
func Dial(ctx context.Context, o Options) (*Client, error) {
	if o.Port <= 0 || o.Port > 65535 || o.Token == "" || len(o.Device.Key) != ed25519.PrivateKeySize {
		return nil, errors.New("gateway dial: bad options")
	}
	if o.Scopes == nil {
		o.Scopes = DefaultScopes
	}
	if o.Platform == "" {
		o.Platform = "windows"
	}
	ws, resp, err := websocket.Dial(ctx, fmt.Sprintf("ws://127.0.0.1:%d", o.Port), nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close() // handshake response; the connection itself lives on in ws
	}
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(8 << 20)
	c := &Client{ws: ws}

	var challenge struct {
		Nonce string `json:"nonce"`
		TS    int64  `json:"ts"`
	}
	for {
		f, err := c.read(ctx)
		if err != nil {
			_ = ws.CloseNow()
			return nil, err
		}
		if f.Type == "event" && f.Event == "connect.challenge" {
			if err := json.Unmarshal(f.Payload, &challenge); err != nil || challenge.Nonce == "" {
				_ = ws.CloseNow()
				return nil, errors.New("gateway sent a bad challenge")
			}
			break
		}
	}
	payload := PayloadV3(o.Device.ID(), ClientID, ClientMode, Role, o.Scopes, challenge.TS, o.Token, challenge.Nonce, o.Platform, "")
	params := map[string]any{
		"minProtocol": ProtocolVersion,
		"maxProtocol": ProtocolVersion,
		"client":      map[string]any{"id": ClientID, "version": o.Version, "platform": o.Platform, "mode": ClientMode},
		"role":        Role,
		"scopes":      o.Scopes,
		"caps":        []string{},
		"auth":        map[string]any{"token": o.Token},
		"device": map[string]any{
			"id": o.Device.ID(), "publicKey": o.Device.PublicKey(), "signature": o.Device.Sign(payload),
			"signedAt": challenge.TS, "nonce": challenge.Nonce,
		},
	}
	res, err := c.request(ctx, "connect", params)
	if err != nil {
		_ = ws.CloseNow()
		return nil, err
	}
	var hello struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(res, &hello) != nil || hello.Type != "hello-ok" {
		_ = ws.CloseNow()
		return nil, ErrAuth
	}
	c.Hello = res
	return c, nil
}

// Close ends the connection.
func (c *Client) Close() error { return c.ws.Close(websocket.StatusNormalClosure, "bye") }

func (c *Client) read(ctx context.Context) (frame, error) {
	_, b, err := c.ws.Read(ctx)
	if err != nil {
		return frame{}, err
	}
	var f frame
	if err := json.Unmarshal(b, &f); err != nil {
		return frame{}, fmt.Errorf("gateway sent invalid JSON: %w", err)
	}
	return f, nil
}

// request sends a req and waits for its res, skipping events.
func (c *Client) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := "om-" + strconv.FormatInt(c.seq.Add(1), 10)
	b, err := json.Marshal(frame{Type: "req", ID: id, Method: method, Params: params})
	if err != nil {
		return nil, err
	}
	if err := c.ws.Write(ctx, websocket.MessageText, b); err != nil {
		return nil, err
	}
	for {
		f, err := c.read(ctx)
		if err != nil {
			return nil, err
		}
		if f.Type != "res" || f.ID != id {
			continue
		}
		if f.OK == nil || !*f.OK {
			if method == "connect" {
				return nil, fmt.Errorf("%w: %s", ErrAuth, string(f.Error))
			}
			return nil, fmt.Errorf("gateway %s failed: %s", method, string(f.Error))
		}
		return f.Payload, nil
	}
}

// ErrAborted / ErrRun are terminal chat outcomes.
var (
	ErrAborted = errors.New("the assistant's turn was stopped")
	ErrRun     = errors.New("the assistant's turn failed")
)

// Chat sends one message on a session and returns the assistant's full reply text.
func (c *Client) Chat(ctx context.Context, sessionKey, message string) (string, error) {
	key := make([]byte, 12)
	_, _ = rand.Read(key)
	res, err := c.request(ctx, "chat.send", map[string]any{
		"sessionKey": sessionKey, "message": message, "idempotencyKey": hex.EncodeToString(key),
	})
	if err != nil {
		return "", err
	}
	var ack struct {
		RunID string `json:"runId"`
	}
	if err := json.Unmarshal(res, &ack); err != nil || ack.RunID == "" {
		return "", errors.New("gateway did not return a runId")
	}
	var text strings.Builder
	for {
		f, err := c.read(ctx)
		if err != nil {
			return "", err
		}
		if f.Type != "event" || f.Event != "chat" {
			continue
		}
		var ev struct {
			RunID        string `json:"runId"`
			State        string `json:"state"`
			DeltaText    string `json:"deltaText"`
			Replace      bool   `json:"replace"`
			ErrorMessage string `json:"errorMessage"`
		}
		if json.Unmarshal(f.Payload, &ev) != nil || ev.RunID != ack.RunID {
			continue
		}
		switch ev.State {
		case "delta":
			if ev.Replace {
				text.Reset()
			}
			text.WriteString(ev.DeltaText)
		case "final":
			return text.String(), nil
		case "aborted":
			return text.String(), ErrAborted
		case "error":
			return "", fmt.Errorf("%w: %s", ErrRun, ev.ErrorMessage)
		}
	}
}

// Abort stops a running turn (chat.abort {sessionKey, runId?}).
func (c *Client) Abort(ctx context.Context, sessionKey, runID string) error {
	p := map[string]any{"sessionKey": sessionKey}
	if runID != "" {
		p["runId"] = runID
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err := c.request(ctx, "chat.abort", p)
	return err
}
