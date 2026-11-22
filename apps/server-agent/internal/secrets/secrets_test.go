package secrets

import (
	"bytes"
	"errors"
	"testing"
)

func roundTrip(t *testing.T, p Protector) {
	t.Helper()
	plain := []byte("JBSWY3DPEHPK3PXP-totp-secret")
	b, err := p.Protect(plain)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, plain) {
		t.Fatal("blob contains the plaintext")
	}
	got, err := p.Unprotect(b)
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("round trip: %q %v", got, err)
	}
	b[len(b)-1] ^= 0xff
	if _, err := p.Unprotect(b); !errors.Is(err, ErrUnprotect) {
		t.Fatalf("tampered blob: want ErrUnprotect, got %v", err)
	}
	if _, err := p.Protect(nil); !errors.Is(err, ErrEmpty) {
		t.Fatalf("empty plaintext: want ErrEmpty, got %v", err)
	}
	if _, err := p.Unprotect(nil); !errors.Is(err, ErrUnprotect) {
		t.Fatalf("empty blob: want ErrUnprotect, got %v", err)
	}
}

func TestMemoryProtector(t *testing.T) {
	m, err := NewMemory()
	if err != nil {
		t.Fatal(err)
	}
	roundTrip(t, m)
	other, _ := NewMemory()
	b, _ := m.Protect([]byte("x"))
	if _, err := other.Unprotect(b); !errors.Is(err, ErrUnprotect) {
		t.Fatal("blob opened with another key")
	}
}
