package manifest

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
	"testing/fstest"
)

func TestTrustedKeysCompiledIn(t *testing.T) {
	ring, err := TrustedKeys()
	if err != nil {
		t.Fatalf("compiled-in keys: %v", err)
	}
	for id, k := range ring {
		if len(k) != ed25519.PublicKeySize {
			t.Errorf("key %s has bad length", id)
		}
	}
}

func TestKeyringFromFiles(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	good := base64.StdEncoding.EncodeToString(pub)
	ring, err := keyringFrom(fstest.MapFS{
		"keys/README.md":         {Data: []byte("x")},
		"keys/om-rel-2026a.pub":  {Data: []byte(good + "\n")},
		"keys/subdir/ignored.md": {Data: []byte("x")},
	})
	if err != nil || len(ring) != 1 || ring["om-rel-2026a"] == nil {
		t.Fatalf("ring %v err %v", ring, err)
	}
	if _, err := keyringFrom(fstest.MapFS{"keys/Bad Name.pub": {Data: []byte(good)}}); err == nil {
		t.Fatal("bad key id accepted")
	}
	if _, err := keyringFrom(fstest.MapFS{"keys/om-x.pub": {Data: []byte("short")}}); err == nil {
		t.Fatal("malformed key accepted")
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.0.0", "1.0.0", 0}, {"1.0.0", "1.0.1", -1}, {"1.10.0", "1.9.9", 1}, {"2.0.0", "1.99.99", 1},
		{"1.0.0-rc.1", "1.0.0", -1}, {"1.0.0", "1.0.0-rc.1", 1}, {"1.0.0-rc.1", "1.0.0-rc.2", -1},
	}
	for _, c := range cases {
		got, err := CompareVersions(c.a, c.b)
		if err != nil || got != c.want {
			t.Errorf("%s vs %s = %d (%v), want %d", c.a, c.b, got, err, c.want)
		}
	}
	if _, err := CompareVersions("v1", "1.0.0"); err == nil {
		t.Fatal("non-semver accepted")
	}
}
