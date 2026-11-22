package manifest

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func writeTree(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for p, content := range files {
		full := filepath.Join(dir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// sample builds a payload dir, zip and a valid manifest for it.
func sample(t *testing.T) (dir, zipPath string, m *Manifest) {
	t.Helper()
	dir = writeTree(t, map[string]string{
		"server-agent.exe":           "MZ fake agent",
		"desk/offmanual-desk.exe":    "MZ fake desk",
		"plugins/guard/index.js":     "export default {}",
		"skills/registry.lock.json":  "{}",
		"openclaw/package.json":      `{"name":"openclaw"}`,
		"node/node.exe":              strings.Repeat("n", 4096),
		"plugins/guard/package.json": `{"name":"guard"}`,
	})
	files, err := ListDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	zipPath = filepath.Join(t.TempDir(), "payload.zip")
	if err := WriteZip(dir, files, zipPath); err != nil {
		t.Fatal(err)
	}
	sum, size, err := HashFile(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	m = &Manifest{
		Schema:          SchemaVersion,
		Version:         "1.2.3",
		Commit:          "abc1234",
		CreatedAt:       time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC),
		Severity:        SeverityNormal,
		MinAgentVersion: "1.0.0",
		OpenClawVersion: "2026.11.1",
		NodeVersion:     "22.11.0",
		KeyID:           "om-test-1",
		Payload:         Payload{Name: "payload.zip", SHA256: sum, Size: size},
		Files:           files,
	}
	return dir, zipPath, m
}

func TestSignVerifyRoundTrip(t *testing.T) {
	_, _, m := sample(t)
	pub, priv := newKey(t)
	body, err := Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := Sign(body, m.KeyID, priv)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Verify(body, sig, Keyring{"om-test-1": pub})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if got.Version != "1.2.3" || len(got.Files) != len(m.Files) {
		t.Fatalf("round trip mismatch: %+v", got)
	}
}

func TestVerifyRejectsTamperedBody(t *testing.T) {
	_, _, m := sample(t)
	pub, priv := newKey(t)
	body, _ := Marshal(m)
	sig, _ := Sign(body, m.KeyID, priv)
	tampered := bytes.Replace(body, []byte(`"1.2.3"`), []byte(`"9.9.9"`), 1)
	if _, err := Verify(tampered, sig, Keyring{"om-test-1": pub}); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("want ErrBadSignature, got %v", err)
	}
	// Even whitespace changes must fail: we sign exact bytes.
	if _, err := Verify(append(body, ' '), sig, Keyring{"om-test-1": pub}); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("whitespace change: want ErrBadSignature, got %v", err)
	}
}

func TestVerifyRejectsWrongOrUnknownKey(t *testing.T) {
	_, _, m := sample(t)
	_, priv := newKey(t)
	otherPub, _ := newKey(t)
	body, _ := Marshal(m)
	sig, _ := Sign(body, m.KeyID, priv)
	if _, err := Verify(body, sig, Keyring{"om-test-1": otherPub}); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("wrong key: want ErrBadSignature, got %v", err)
	}
	if _, err := Verify(body, sig, Keyring{"om-other": otherPub}); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("unknown key: want ErrUnknownKey, got %v", err)
	}
	if _, err := Verify(body, sig, Keyring{}); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("empty keyring (revoked): want ErrUnknownKey, got %v", err)
	}
}

func TestVerifyRejectsKeyIDMismatch(t *testing.T) {
	_, _, m := sample(t)
	pub, priv := newKey(t)
	body, _ := Marshal(m) // manifest says om-test-1
	sig, _ := Sign(body, "om-test-2", priv)
	if _, err := Verify(body, sig, Keyring{"om-test-2": pub}); !errors.Is(err, ErrKeyIDMismatch) {
		t.Fatalf("want ErrKeyIDMismatch, got %v", err)
	}
}

func TestVerifyRejectsMalformedSignature(t *testing.T) {
	_, _, m := sample(t)
	pub, _ := newKey(t)
	body, _ := Marshal(m)
	cases := []Signature{
		{Schema: 1, Alg: "rsa", KeyID: "om-test-1", Sig: "AAAA"},
		{Schema: 2, Alg: AlgEd25519, KeyID: "om-test-1", Sig: "AAAA"},
		{Schema: 1, Alg: AlgEd25519, KeyID: "om-test-1", Sig: "not base64!"},
		{Schema: 1, Alg: AlgEd25519, KeyID: "om-test-1", Sig: base64.StdEncoding.EncodeToString([]byte("short"))},
	}
	for i, s := range cases {
		if _, err := Verify(body, s, Keyring{"om-test-1": pub}); err == nil {
			t.Errorf("case %d: expected error", i)
		}
	}
}

func TestParseRejectsUnknownFieldsAndTrailingData(t *testing.T) {
	_, _, m := sample(t)
	body, _ := Marshal(m)
	withExtra := bytes.Replace(body, []byte(`"schema": 1,`), []byte(`"schema": 1, "evil": true,`), 1)
	if _, err := Parse(withExtra); err == nil {
		t.Fatal("unknown field accepted")
	}
	if _, err := Parse(append(body, []byte("{}")...)); err == nil {
		t.Fatal("trailing data accepted")
	}
}

func TestValidate(t *testing.T) {
	deadline := time.Date(2026, 11, 29, 0, 0, 0, 0, time.UTC)
	before := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	cases := map[string]func(m *Manifest){
		"bad schema":              func(m *Manifest) { m.Schema = 2 },
		"bad version":             func(m *Manifest) { m.Version = "v1.2" },
		"bad min agent":           func(m *Manifest) { m.MinAgentVersion = "1" },
		"missing openclaw":        func(m *Manifest) { m.OpenClawVersion = "" },
		"missing commit":          func(m *Manifest) { m.Commit = "" },
		"zero createdAt":          func(m *Manifest) { m.CreatedAt = time.Time{} },
		"unknown severity":        func(m *Manifest) { m.Severity = "urgent" },
		"security no deadline":    func(m *Manifest) { m.Severity = SeveritySecurity },
		"normal with deadline":    func(m *Manifest) { m.DeadlineAt = &deadline },
		"deadline before created": func(m *Manifest) { m.Severity = SeveritySecurity; m.DeadlineAt = &before },
		"bad key id":              func(m *Manifest) { m.KeyID = "Bad Key" },
		"payload name with dir":   func(m *Manifest) { m.Payload.Name = "a/payload.zip" },
		"payload bad sha":         func(m *Manifest) { m.Payload.SHA256 = "XYZ" },
		"no files":                func(m *Manifest) { m.Files = nil },
		"unsorted files":          func(m *Manifest) { m.Files[0], m.Files[1] = m.Files[1], m.Files[0] },
		"dup case-insensitive": func(m *Manifest) {
			f := m.Files[len(m.Files)-1]
			f.Path = strings.ToUpper(f.Path)
			m.Files = append([]File{f}, m.Files...)
		},
		"file bad sha":  func(m *Manifest) { m.Files[0].SHA256 = strings.Repeat("A", 64) },
		"file neg size": func(m *Manifest) { m.Files[0].Size = -1 },
		"file unsafe":   func(m *Manifest) { m.Files[0].Path = "../evil.exe" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			_, _, m := sample(t)
			mutate(m)
			if err := m.Validate(); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
	t.Run("security with deadline ok", func(t *testing.T) {
		_, _, m := sample(t)
		m.Severity = SeveritySecurity
		m.DeadlineAt = &deadline
		if err := m.Validate(); err != nil {
			t.Fatal(err)
		}
	})
}

func TestSafePath(t *testing.T) {
	good := []string{"a.txt", "dir/sub/file.js", "node/node.exe", "x/.hidden", "a..b/c"}
	bad := []string{
		"", "/abs", "../up", "a/../b", "a/./b", "a//b", "a\\b", "C:/x", "C:x",
		"file.txt:ads", "con", "dir/NUL.txt", "LPT1", "trailing.", "space ", "a/b./c",
		"ctl\x01", "q?", "star*", strings.Repeat("a", 241),
	}
	for _, p := range good {
		if err := SafePath(p); err != nil {
			t.Errorf("SafePath(%q) unexpectedly failed: %v", p, err)
		}
	}
	for _, p := range bad {
		if err := SafePath(p); err == nil {
			t.Errorf("SafePath(%q) unexpectedly passed", p)
		}
	}
}

func TestKeyParsing(t *testing.T) {
	pub, priv := newKey(t)
	gotPub, err := ParsePublicKey(base64.StdEncoding.EncodeToString(pub) + "\n")
	if err != nil || !bytes.Equal(gotPub, pub) {
		t.Fatalf("ParsePublicKey: %v", err)
	}
	gotPriv, err := ParsePrivateKeySeed(base64.StdEncoding.EncodeToString(priv.Seed()))
	if err != nil || !bytes.Equal(gotPriv, priv) {
		t.Fatalf("ParsePrivateKeySeed: %v", err)
	}
	if _, err := ParsePublicKey("AAAA"); err == nil {
		t.Fatal("short public key accepted")
	}
	if _, err := ParsePrivateKeySeed("!!"); err == nil {
		t.Fatal("bad seed accepted")
	}
	if _, err := Sign([]byte("x"), "om-test-1", ed25519.PrivateKey([]byte("short"))); err == nil {
		t.Fatal("short private key accepted")
	}
	if _, err := Sign([]byte("x"), "BAD ID", priv); err == nil {
		t.Fatal("bad key id accepted")
	}
}

func TestParseSignatureStrict(t *testing.T) {
	if _, err := ParseSignature([]byte(`{"schema":1,"alg":"ed25519","keyId":"k1","sig":"x","extra":1}`)); err == nil {
		t.Fatal("unknown field accepted")
	}
	s, err := ParseSignature([]byte(`{"schema":1,"alg":"ed25519","keyId":"k1","sig":"x"}`))
	if err != nil || s.KeyID != "k1" {
		t.Fatalf("parse: %v %+v", err, s)
	}
}

func TestZipIsDeterministic(t *testing.T) {
	dir, zipPath, m := sample(t)
	again := filepath.Join(t.TempDir(), "again.zip")
	if err := WriteZip(dir, m.Files, again); err != nil {
		t.Fatal(err)
	}
	a, _ := os.ReadFile(zipPath)
	b, _ := os.ReadFile(again)
	if !bytes.Equal(a, b) {
		t.Fatal("zip output is not reproducible")
	}
}

func TestExtractAndVerifyDir(t *testing.T) {
	_, zipPath, m := sample(t)
	if err := VerifyFileHash(zipPath, m.Payload.SHA256, m.Payload.Size); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "versions", "1.2.3")
	if err := ExtractZip(zipPath, dest, m); err != nil {
		t.Fatalf("extract: %v", err)
	}
	if err := VerifyDir(dest, m); err != nil {
		t.Fatalf("verify dir: %v", err)
	}
	// Extracting again into an existing directory is refused.
	if err := ExtractZip(zipPath, dest, m); err == nil {
		t.Fatal("extract into existing dir allowed")
	}
}

func TestVerifyDirDetectsChanges(t *testing.T) {
	_, zipPath, m := sample(t)
	extract := func(t *testing.T) string {
		dest := filepath.Join(t.TempDir(), "v")
		if err := ExtractZip(zipPath, dest, m); err != nil {
			t.Fatal(err)
		}
		return dest
	}
	t.Run("modified", func(t *testing.T) {
		d := extract(t)
		_ = os.WriteFile(filepath.Join(d, "server-agent.exe"), []byte("MZ evil agent"), 0o644)
		if err := VerifyDir(d, m); !errors.Is(err, ErrHashMismatch) {
			t.Fatalf("want ErrHashMismatch, got %v", err)
		}
	})
	t.Run("extra", func(t *testing.T) {
		d := extract(t)
		_ = os.WriteFile(filepath.Join(d, "plugins", "evil.js"), []byte("x"), 0o644)
		if err := VerifyDir(d, m); !errors.Is(err, ErrUnexpectedFile) {
			t.Fatalf("want ErrUnexpectedFile, got %v", err)
		}
	})
	t.Run("missing", func(t *testing.T) {
		d := extract(t)
		_ = os.Remove(filepath.Join(d, "node", "node.exe"))
		if err := VerifyDir(d, m); !errors.Is(err, ErrMissingFile) {
			t.Fatalf("want ErrMissingFile, got %v", err)
		}
	})
	t.Run("payload hash", func(t *testing.T) {
		if err := VerifyFileHash(zipPath, strings.Repeat("0", 64), m.Payload.Size); !errors.Is(err, ErrHashMismatch) {
			t.Fatalf("want ErrHashMismatch, got %v", err)
		}
	})
}

// craftZip writes a zip with arbitrary entry names and contents.
func craftZip(t *testing.T, entries [][2]string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "crafted.zip")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for _, e := range entries {
		w, err := zw.Create(e[0])
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(e[1]))
	}
	_ = zw.Close()
	_ = f.Close()
	return p
}

func manifestFor(entries map[string]string) *Manifest {
	var files []File
	for p, c := range entries {
		files = append(files, File{Path: p, SHA256: hexSha([]byte(c)), Size: int64(len(c))})
	}
	sortFiles(files)
	return &Manifest{Files: files}
}

func TestExtractRejectsHostileZips(t *testing.T) {
	ok := map[string]string{"a.txt": "hello"}
	cases := map[string]struct {
		entries [][2]string
		want    error
	}{
		"zip slip":        {[][2]string{{"a.txt", "hello"}, {"../../evil.txt", "x"}}, ErrUnexpectedFile},
		"unlisted file":   {[][2]string{{"a.txt", "hello"}, {"b.txt", "x"}}, ErrUnexpectedFile},
		"missing file":    {[][2]string{}, ErrMissingFile},
		"wrong content":   {[][2]string{{"a.txt", "HELLO"}}, ErrHashMismatch},
		"wrong size":      {[][2]string{{"a.txt", "hello world"}}, ErrHashMismatch},
		"duplicate entry": {[][2]string{{"a.txt", "hello"}, {"a.txt", "hello"}}, nil},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			zp := craftZip(t, tc.entries)
			dest := filepath.Join(t.TempDir(), "out")
			err := ExtractZip(zp, dest, manifestFor(ok))
			if err == nil {
				t.Fatal("hostile zip accepted")
			}
			if tc.want != nil && !errors.Is(err, tc.want) {
				t.Fatalf("want %v, got %v", tc.want, err)
			}
			if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
				t.Fatal("destination not cleaned up after failure")
			}
		})
	}
}

func TestListDirSortedWithHashes(t *testing.T) {
	dir := writeTree(t, map[string]string{"b/2.txt": "two", "a.txt": "one", "b/1.txt": ""})
	files, err := ListDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := []File{
		{Path: "a.txt", SHA256: hexSha([]byte("one")), Size: 3},
		{Path: "b/1.txt", SHA256: hexSha(nil), Size: 0},
		{Path: "b/2.txt", SHA256: hexSha([]byte("two")), Size: 3},
	}
	if len(files) != len(want) {
		t.Fatalf("got %d files, want %d", len(files), len(want))
	}
	for i := range want {
		if files[i] != want[i] {
			t.Errorf("file %d = %+v, want %+v", i, files[i], want[i])
		}
	}
}

func TestListDirMissingDir(t *testing.T) {
	if _, err := ListDir(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("missing dir accepted")
	}
}

func hexSha(b []byte) string {
	s := sha256.Sum256(b)
	return hexSum(s[:])
}
