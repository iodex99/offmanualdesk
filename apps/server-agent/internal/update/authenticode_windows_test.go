//go:build windows

package update

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestVerifyAuthenticodeRefusesUnsignedAndTampered(t *testing.T) {
	unsigned := filepath.Join(t.TempDir(), "unsigned.exe")
	if err := os.WriteFile(unsigned, []byte("MZ not really a program"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := VerifyAuthenticode(unsigned); !errors.Is(err, ErrUntrustedBinary) {
		t.Fatalf("unsigned file: %v", err)
	}
	// A binary with an embedded signature, when one is available (GitHub's Windows
	// runners have Git for Windows, whose git.exe is Authenticode-signed).
	signed := `C:\Program Files\Git\cmd\git.exe`
	b, err := os.ReadFile(signed)
	if err != nil {
		t.Skip("no signed reference binary on this machine")
	}
	if err := VerifyAuthenticode(signed); err != nil {
		t.Skipf("reference binary didn't verify here (offline revocation?): %v", err)
	}
	b[len(b)/2]++
	tampered := filepath.Join(t.TempDir(), "git.exe")
	if err := os.WriteFile(tampered, b, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := VerifyAuthenticode(tampered); !errors.Is(err, ErrUntrustedBinary) {
		t.Fatalf("tampered copy verified: %v", err)
	}
}
