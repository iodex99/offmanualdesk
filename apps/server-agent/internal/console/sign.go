// Package console is the Server Agent's client for the Off Manual console API
// (docs/ARCHITECTURE.md §3.3). Every request is signed with the server's ed25519
// key (ADR-013, ADR-035); the console verifies signature, timestamp and nonce
// before anything else.
package console

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Header names (shared with apps/console/lib/agent-auth.ts).
const (
	HeaderServer    = "X-OM-Server"
	HeaderTimestamp = "X-OM-Timestamp"
	HeaderNonce     = "X-OM-Nonce"
	HeaderSignature = "X-OM-Signature"
)

// SignatureVersion prefixes the canonical string (domain separation).
const SignatureVersion = "OM-AGENT-1"

// Canonical builds the exact bytes that are signed:
//
//	OM-AGENT-1\n<METHOD>\n<path?query>\n<server id>\n<unix seconds>\n<nonce>\n<hex sha256(body)>
func Canonical(method, pathAndQuery, serverID string, ts int64, nonce string, body []byte) []byte {
	sum := sha256.Sum256(body)
	return []byte(strings.Join([]string{
		SignatureVersion, strings.ToUpper(method), pathAndQuery, serverID,
		strconv.FormatInt(ts, 10), nonce, hex.EncodeToString(sum[:]),
	}, "\n"))
}

// Signed holds the headers for one request.
type Signed struct {
	ServerID, Timestamp, Nonce, Signature string
}

// Sign signs a request. nonce "" means generate 16 random bytes.
func Sign(priv ed25519.PrivateKey, method, pathAndQuery, serverID string, now time.Time, nonce string, body []byte) (Signed, error) {
	if len(priv) != ed25519.PrivateKeySize {
		return Signed{}, fmt.Errorf("invalid private key")
	}
	if nonce == "" {
		b := make([]byte, 16)
		if _, err := rand.Read(b); err != nil {
			return Signed{}, err
		}
		nonce = hex.EncodeToString(b)
	}
	ts := now.Unix()
	sig := ed25519.Sign(priv, Canonical(method, pathAndQuery, serverID, ts, nonce, body))
	return Signed{ServerID: serverID, Timestamp: strconv.FormatInt(ts, 10), Nonce: nonce,
		Signature: base64.StdEncoding.EncodeToString(sig)}, nil
}

// Verify checks a signature (used in tests and by tools; the console has its own TS copy).
func Verify(pub ed25519.PublicKey, method, pathAndQuery string, s Signed, body []byte) bool {
	ts, err := strconv.ParseInt(s.Timestamp, 10, 64)
	if err != nil {
		return false
	}
	sig, err := base64.StdEncoding.DecodeString(s.Signature)
	if err != nil {
		return false
	}
	return ed25519.Verify(pub, Canonical(method, pathAndQuery, s.ServerID, ts, s.Nonce, body), sig)
}
