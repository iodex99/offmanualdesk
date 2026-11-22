package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type env map[string]string

func (e env) get(k string) string { return e[k] }

func mustRun(t *testing.T, e env, args ...string) string {
	t.Helper()
	var out, errOut bytes.Buffer
	if code := run(args, &out, &errOut, e.get); code != 0 {
		t.Fatalf("%v exited %d: %s", args, code, errOut.String())
	}
	return out.String()
}

func TestEndToEndKeygenBuildSignVerify(t *testing.T) {
	tmp := t.TempDir()
	payload := filepath.Join(tmp, "payload")
	for p, c := range map[string]string{"server-agent.exe": "MZ", "desk/desk.exe": "MZ2", "openclaw/package.json": "{}"} {
		full := filepath.Join(payload, filepath.FromSlash(p))
		_ = os.MkdirAll(filepath.Dir(full), 0o755)
		if err := os.WriteFile(full, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	pub, priv := filepath.Join(tmp, "k.pub"), filepath.Join(tmp, "k.seed")
	mustRun(t, env{}, "keygen", "-key-id", "om-test-1", "-out-public", pub, "-out-private", priv)

	out := filepath.Join(tmp, "out")
	_ = os.MkdirAll(out, 0o755)
	man, sig, zip := filepath.Join(out, "manifest.json"), filepath.Join(out, "manifest.sig.json"), filepath.Join(out, "payload.zip")
	mustRun(t, env{}, "build", "-dir", payload, "-version", "v1.2.3", "-commit", "abc", "-openclaw", "2026.11.1",
		"-node", "22.11.0", "-min-agent", "1.0.0", "-key-id", "om-test-1", "-zip", zip, "-out", man,
		"-created-at", "2026-11-22T10:00:00Z")

	seed, _ := os.ReadFile(priv)
	mustRun(t, env{"RELEASE_SIGNING_KEY": strings.TrimSpace(string(seed))}, "sign", "-manifest", man, "-out", sig)
	got := mustRun(t, env{}, "verify", "-manifest", man, "-sig", sig, "-pubkey-file", pub, "-zip", zip)
	if !strings.Contains(got, "OK: 1.2.3") {
		t.Fatalf("unexpected verify output: %q", got)
	}

	// Reproducible: building again with the same inputs gives identical bytes.
	man2, zip2 := filepath.Join(out, "m2.json"), filepath.Join(out, "p2.zip")
	mustRun(t, env{}, "build", "-dir", payload, "-version", "1.2.3", "-commit", "abc", "-openclaw", "2026.11.1",
		"-node", "22.11.0", "-min-agent", "1.0.0", "-key-id", "om-test-1", "-zip", zip2, "-out", man2,
		"-created-at", "2026-11-22T10:00:00Z")
	a, _ := os.ReadFile(zip)
	b, _ := os.ReadFile(zip2)
	if !bytes.Equal(a, b) {
		t.Fatal("payload zip not reproducible")
	}

	// Tampered manifest fails verification.
	body, _ := os.ReadFile(man)
	_ = os.WriteFile(man, bytes.Replace(body, []byte("1.2.3"), []byte("1.2.4"), 1), 0o644)
	var o, e bytes.Buffer
	if code := run([]string{"verify", "-manifest", man, "-sig", sig, "-pubkey-file", pub}, &o, &e, env{}.get); code == 0 {
		t.Fatal("tampered manifest verified")
	}
}

func TestSignRequiresKeyEnv(t *testing.T) {
	var o, e bytes.Buffer
	if code := run([]string{"sign", "-manifest", "x", "-out", "y"}, &o, &e, env{}.get); code == 0 {
		t.Fatal("sign without key succeeded")
	}
	if !strings.Contains(e.String(), "RELEASE_SIGNING_KEY") {
		t.Fatalf("error should name the env var: %q", e.String())
	}
}

func TestUsageAndUnknown(t *testing.T) {
	var o, e bytes.Buffer
	if code := run(nil, &o, &e, env{}.get); code != 2 {
		t.Fatalf("no args exit %d", code)
	}
	if code := run([]string{"nope"}, &o, &e, env{}.get); code != 1 {
		t.Fatalf("unknown exit %d", code)
	}
	if code := run([]string{"build"}, &o, &e, env{}.get); code != 1 {
		t.Fatalf("build without flags exit %d", code)
	}
	if code := run([]string{"keygen"}, &o, &e, env{}.get); code != 1 {
		t.Fatalf("keygen without flags exit %d", code)
	}
	if code := run([]string{"verify"}, &o, &e, env{}.get); code != 1 {
		t.Fatalf("verify without flags exit %d", code)
	}
}

func TestBuildRejectsBadSeverityDeadline(t *testing.T) {
	tmp := t.TempDir()
	payload := filepath.Join(tmp, "p")
	_ = os.MkdirAll(payload, 0o755)
	_ = os.WriteFile(filepath.Join(payload, "a.txt"), []byte("a"), 0o644)
	var o, e bytes.Buffer
	args := []string{"build", "-dir", payload, "-version", "1.0.0", "-commit", "c", "-openclaw", "x", "-node", "22",
		"-min-agent", "1.0.0", "-key-id", "om-test-1", "-zip", filepath.Join(tmp, "p.zip"), "-out", filepath.Join(tmp, "m.json"),
		"-severity", "security"}
	if code := run(args, &o, &e, env{}.get); code == 0 {
		t.Fatal("security release without deadline accepted")
	}
}

func TestBuildRecordsAuthenticode(t *testing.T) {
	tmp := t.TempDir()
	payload := filepath.Join(tmp, "p")
	_ = os.MkdirAll(payload, 0o755)
	_ = os.WriteFile(filepath.Join(payload, "a.exe"), []byte("MZ"), 0o644)
	for _, signed := range []bool{true, false} {
		out := filepath.Join(tmp, "m.json")
		args := []string{"build", "-dir", payload, "-version", "1.0.0", "-commit", "c", "-openclaw", "x", "-node", "22",
			"-min-agent", "1.0.0", "-key-id", "om-test-1", "-zip", filepath.Join(tmp, "p.zip"), "-out", out}
		if signed {
			args = append(args, "-authenticode=true")
		}
		var o, e bytes.Buffer
		if code := run(args, &o, &e, env{}.get); code != 0 {
			t.Fatalf("build: %s", e.String())
		}
		body, _ := os.ReadFile(out)
		var m struct {
			Authenticode bool `json:"authenticode"`
		}
		if err := json.Unmarshal(body, &m); err != nil || m.Authenticode != signed {
			t.Fatalf("signed=%v manifest %s (%v)", signed, body, err)
		}
	}
}
