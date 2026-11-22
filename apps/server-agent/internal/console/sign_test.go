package console

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The golden vector is shared with apps/console (TypeScript). If either side
// changes the canonical string, one of the two test suites fails.
type vector struct {
	SeedB64      string `json:"seedBase64"`
	PublicKeyB64 string `json:"publicKeyBase64"`
	Method       string `json:"method"`
	PathAndQuery string `json:"pathAndQuery"`
	ServerID     string `json:"serverId"`
	Timestamp    int64  `json:"timestamp"`
	Nonce        string `json:"nonce"`
	Body         string `json:"body"`
	Canonical    string `json:"canonical"`
	Signature    string `json:"signatureBase64"`
}

func loadVector(t *testing.T) vector {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "shared-schema", "fixtures", "agent-signature.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v vector
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestGoldenVector(t *testing.T) {
	v := loadVector(t)
	seed, _ := base64.StdEncoding.DecodeString(v.SeedB64)
	priv := ed25519.NewKeyFromSeed(seed)
	if got := base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey)); got != v.PublicKeyB64 {
		t.Fatalf("public key %s, want %s", got, v.PublicKeyB64)
	}
	if got := string(Canonical(v.Method, v.PathAndQuery, v.ServerID, v.Timestamp, v.Nonce, []byte(v.Body))); got != v.Canonical {
		t.Fatalf("canonical:\n%q\nwant\n%q", got, v.Canonical)
	}
	s, err := Sign(priv, v.Method, v.PathAndQuery, v.ServerID, time.Unix(v.Timestamp, 0), v.Nonce, []byte(v.Body))
	if err != nil {
		t.Fatal(err)
	}
	if s.Signature != v.Signature {
		t.Fatalf("signature %s, want %s", s.Signature, v.Signature)
	}
	if !Verify(priv.Public().(ed25519.PublicKey), v.Method, v.PathAndQuery, s, []byte(v.Body)) {
		t.Fatal("verify failed")
	}
}

func TestVerifyRejectsAnyChange(t *testing.T) {
	v := loadVector(t)
	seed, _ := base64.StdEncoding.DecodeString(v.SeedB64)
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)
	s, _ := Sign(priv, "POST", "/api/agent/heartbeat", "srv_1", time.Unix(1700000000, 0), "n1", []byte(`{"a":1}`))
	mut := []func(s *Signed) (string, string, []byte){
		func(*Signed) (string, string, []byte) { return "GET", "/api/agent/heartbeat", []byte(`{"a":1}`) },
		func(*Signed) (string, string, []byte) { return "POST", "/api/agent/policy", []byte(`{"a":1}`) },
		func(*Signed) (string, string, []byte) { return "POST", "/api/agent/heartbeat", []byte(`{"a":2}`) },
		func(s *Signed) (string, string, []byte) {
			s.ServerID = "srv_2"
			return "POST", "/api/agent/heartbeat", []byte(`{"a":1}`)
		},
		func(s *Signed) (string, string, []byte) {
			s.Timestamp = "1700000001"
			return "POST", "/api/agent/heartbeat", []byte(`{"a":1}`)
		},
		func(s *Signed) (string, string, []byte) {
			s.Nonce = "n2"
			return "POST", "/api/agent/heartbeat", []byte(`{"a":1}`)
		},
		func(s *Signed) (string, string, []byte) {
			s.Signature = "AAAA"
			return "POST", "/api/agent/heartbeat", []byte(`{"a":1}`)
		},
		func(s *Signed) (string, string, []byte) {
			s.Timestamp = "x"
			return "POST", "/api/agent/heartbeat", []byte(`{"a":1}`)
		},
	}
	for i, m := range mut {
		c := s
		method, path, body := m(&c)
		if Verify(pub, method, path, c, body) {
			t.Errorf("mutation %d verified", i)
		}
	}
	if _, err := Sign(ed25519.PrivateKey{1}, "GET", "/", "s", time.Now(), "", nil); err == nil {
		t.Fatal("bad key accepted")
	}
	r, _ := Sign(priv, "GET", "/", "s", time.Now(), "", nil)
	if len(r.Nonce) != 32 {
		t.Fatalf("generated nonce %q", r.Nonce)
	}
}
