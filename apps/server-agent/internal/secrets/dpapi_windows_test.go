//go:build windows

package secrets

import (
	"errors"
	"testing"
)

func TestDPAPIProtector(t *testing.T) {
	roundTrip(t, Default())
}

func TestDPAPIRefusesEmpty(t *testing.T) {
	if _, err := Default().Protect(nil); !errors.Is(err, ErrEmpty) {
		t.Fatalf("want ErrEmpty, got %v", err)
	}
}
