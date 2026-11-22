package update

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"offmanual/desk/server-agent/pkg/manifest"
)

type states struct {
	mu  sync.Mutex
	log []string
}

func (s *states) SetUpdateState(_ context.Context, v, st, msg string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.log = append(s.log, v+":"+st)
	_ = msg
	return nil
}

// releaseServer builds and signs a real release and serves it over HTTP.
type releaseServer struct {
	srv       *httptest.Server
	manifest  []byte
	sig       []byte
	payload   []byte
	payloadNm string
	sum       string
	pub       ed25519.PublicKey
}

func newRelease(t *testing.T, version, minAgent string, opts ...func(*manifest.Manifest)) *releaseServer {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	dir := t.TempDir()
	for p, c := range map[string]string{"server-agent.exe": "MZ agent " + version, "desk/offmanual-desk.exe": "MZ desk", "openclaw/package.json": "{}"} {
		full := filepath.Join(dir, filepath.FromSlash(p))
		_ = os.MkdirAll(filepath.Dir(full), 0o755)
		_ = os.WriteFile(full, []byte(c), 0o644)
	}
	files, err := manifest.ListDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	zipPath := filepath.Join(t.TempDir(), "offmanual-"+version+".zip")
	if err := manifest.WriteZip(dir, files, zipPath); err != nil {
		t.Fatal(err)
	}
	sum, size, _ := manifest.HashFile(zipPath)
	m := &manifest.Manifest{Schema: 1, Version: version, Commit: "c", CreatedAt: time.Date(2026, 11, 23, 0, 0, 0, 0, time.UTC),
		Severity: manifest.SeverityNormal, MinAgentVersion: minAgent, OpenClawVersion: "2026.11.6", NodeVersion: "24.22.3",
		KeyID: "om-test-1", Payload: manifest.Payload{Name: filepath.Base(zipPath), SHA256: sum, Size: size}, Files: files}
	for _, o := range opts {
		o(m)
	}
	body, err := manifest.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	sig, _ := manifest.Sign(body, "om-test-1", priv)
	sigBytes, _ := json.Marshal(sig)
	payload, _ := os.ReadFile(zipPath)
	r := &releaseServer{manifest: body, sig: sigBytes, payload: payload, payloadNm: filepath.Base(zipPath), sum: sum, pub: pub}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch filepath.Base(req.URL.Path) {
		case "manifest.json":
			_, _ = w.Write(r.manifest)
		case "manifest.sig.json":
			_, _ = w.Write(r.sig)
		case r.payloadNm:
			_, _ = w.Write(r.payload)
		default:
			http.NotFound(w, req)
		}
	}))
	t.Cleanup(r.srv.Close)
	return r
}

func (r *releaseServer) release(version string) Release {
	return Release{Version: version, ManifestURL: r.srv.URL + "/releases/" + version + "/manifest.json", PayloadSHA256: r.sum, KeyID: "om-test-1"}
}

func stager(t *testing.T, r *releaseServer, st *states) *Stager {
	t.Helper()
	root := t.TempDir()
	return &Stager{VersionsDir: filepath.Join(root, "versions"), StagingDir: filepath.Join(root, "staging"),
		Keys: manifest.Keyring{"om-test-1": r.pub}, AgentVersion: "1.0.0", States: st}
}

func TestStageVerifiesAndUnpacksSideBySide(t *testing.T) {
	r := newRelease(t, "1.2.0", "1.0.0")
	st := &states{}
	s := stager(t, r, st)
	_ = os.MkdirAll(s.VersionsDir, 0o755)
	if err := s.Stage(context.Background(), r.release("1.2.0")); err != nil {
		t.Fatalf("stage: %v", err)
	}
	got, _ := os.ReadFile(filepath.Join(s.VersionsDir, "1.2.0", "server-agent.exe"))
	if string(got) != "MZ agent 1.2.0" {
		t.Fatalf("payload not unpacked: %q", got)
	}
	if _, err := os.Stat(filepath.Join(s.VersionsDir, "1.2.0.manifest.json")); err != nil {
		t.Fatal("manifest not kept")
	}
	// Idempotent: a second run verifies and keeps it.
	if err := s.Stage(context.Background(), r.release("1.2.0")); err != nil {
		t.Fatalf("restage: %v", err)
	}
	if strings.Join(st.log, ",") != "1.2.0:downloading,1.2.0:staged,1.2.0:downloading,1.2.0:staged" {
		t.Fatalf("states %v", st.log)
	}
}

func TestStageRefusesTamperingAndWrongKeys(t *testing.T) {
	ctx := context.Background()
	t.Run("payload changed", func(t *testing.T) {
		r := newRelease(t, "1.2.0", "1.0.0")
		r.payload = append([]byte(nil), r.payload...)
		r.payload[len(r.payload)/2] ^= 0xff
		s := stager(t, r, &states{})
		if err := s.Stage(ctx, r.release("1.2.0")); !errors.Is(err, manifest.ErrHashMismatch) {
			t.Fatalf("want hash mismatch, got %v", err)
		}
		if _, err := os.Stat(filepath.Join(s.VersionsDir, "1.2.0")); !os.IsNotExist(err) {
			t.Fatal("tampered release was unpacked")
		}
	})
	t.Run("signed by another key", func(t *testing.T) {
		r := newRelease(t, "1.2.0", "1.0.0")
		s := stager(t, r, &states{})
		other, _, _ := ed25519.GenerateKey(rand.Reader)
		s.Keys = manifest.Keyring{"om-test-1": other}
		if err := s.Stage(ctx, r.release("1.2.0")); !errors.Is(err, manifest.ErrBadSignature) {
			t.Fatalf("want bad signature, got %v", err)
		}
	})
	t.Run("no trusted keys", func(t *testing.T) {
		r := newRelease(t, "1.2.0", "1.0.0")
		s := stager(t, r, &states{})
		s.Keys = manifest.Keyring{}
		if err := s.Stage(ctx, r.release("1.2.0")); !errors.Is(err, manifest.ErrUnknownKey) {
			t.Fatalf("want unknown key, got %v", err)
		}
	})
	t.Run("console said a different payload", func(t *testing.T) {
		r := newRelease(t, "1.2.0", "1.0.0")
		s := stager(t, r, &states{})
		rel := r.release("1.2.0")
		rel.PayloadSHA256 = strings.Repeat("0", 64)
		if err := s.Stage(ctx, rel); !errors.Is(err, ErrMismatch) {
			t.Fatalf("want mismatch, got %v", err)
		}
	})
	t.Run("needs a newer agent", func(t *testing.T) {
		r := newRelease(t, "2.0.0", "1.5.0")
		s := stager(t, r, &states{})
		if err := s.Stage(ctx, r.release("2.0.0")); !errors.Is(err, ErrNeedsNewerAgent) {
			t.Fatalf("want needs newer agent, got %v", err)
		}
	})
	t.Run("plain HTTP to a real host is refused", func(t *testing.T) {
		r := newRelease(t, "1.2.0", "1.0.0")
		s := stager(t, r, &states{})
		rel := r.release("1.2.0")
		rel.ManifestURL = "http://releases.example.com/1.2.0/manifest.json"
		if err := s.Stage(ctx, rel); err == nil || !strings.Contains(err.Error(), "non-HTTPS") {
			t.Fatalf("want non-HTTPS refusal, got %v", err)
		}
	})
}

func TestStageReplacesAModifiedStagedCopy(t *testing.T) {
	r := newRelease(t, "1.2.0", "1.0.0")
	s := stager(t, r, &states{})
	ctx := context.Background()
	_ = os.MkdirAll(s.VersionsDir, 0o755)
	if err := s.Stage(ctx, r.release("1.2.0")); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(s.VersionsDir, "1.2.0", "server-agent.exe"), []byte("MZ evil"), 0o644)
	if err := s.Stage(ctx, r.release("1.2.0")); err != nil {
		t.Fatalf("restage after tampering: %v", err)
	}
	got, _ := os.ReadFile(filepath.Join(s.VersionsDir, "1.2.0", "server-agent.exe"))
	if string(got) != "MZ agent 1.2.0" {
		t.Fatal("tampered file survived")
	}
	entries, _ := os.ReadDir(s.VersionsDir)
	quarantined := false
	for _, e := range entries {
		quarantined = quarantined || strings.HasPrefix(e.Name(), "1.2.0.bad-")
	}
	if !quarantined {
		t.Fatal("tampered copy was not kept aside for inspection")
	}
}

func TestSibling(t *testing.T) {
	u, err := sibling("https://r.example/releases/1.2.0/manifest.json?sig=abc", "offmanual-1.2.0.zip")
	if err != nil || u != "https://r.example/releases/1.2.0/offmanual-1.2.0.zip?sig=abc" {
		t.Fatalf("%q %v", u, err)
	}
	for _, bad := range []string{"../x", "a/b", "", ".."} {
		if _, err := sibling("https://r.example/x/manifest.json", bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestStageRequiresAuthenticodeWhenTheManifestSaysSo(t *testing.T) {
	signed := func(m *manifest.Manifest) { m.Authenticode = true }
	r := newRelease(t, "1.3.0", "1.0.0", signed)
	var checked []string
	s := stager(t, r, &states{})
	s.Authenticode = func(path string) error {
		checked = append(checked, filepath.Base(path))
		if filepath.Base(path) == "offmanual-desk.exe" {
			return errors.New("TRUST_E_NOSIGNATURE")
		}
		return nil
	}
	err := s.Stage(context.Background(), r.release("1.3.0"))
	if !errors.Is(err, ErrUntrustedBinary) || !strings.Contains(err.Error(), "desk/offmanual-desk.exe") {
		t.Fatalf("unsigned desk accepted: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(s.VersionsDir, "1.3.0")); !os.IsNotExist(statErr) {
		t.Fatal("an untrusted release was left in versions")
	}
	s.Authenticode = func(path string) error { checked = append(checked, filepath.Base(path)); return nil }
	checked = nil
	if err := s.Stage(context.Background(), r.release("1.3.0")); err != nil {
		t.Fatal(err)
	}
	if len(checked) != 2 { // server-agent.exe and offmanual-desk.exe; package.json isn't a binary
		t.Fatalf("checked %v", checked)
	}

	// Releases without the flag (dev, ring 0) don't call the check at all.
	plain := newRelease(t, "1.4.0", "1.0.0")
	s2 := stager(t, plain, &states{})
	s2.Authenticode = func(string) error { t.Fatal("check called for an unsigned release"); return nil }
	if err := s2.Stage(context.Background(), plain.release("1.4.0")); err != nil {
		t.Fatal(err)
	}
}
