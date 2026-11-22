//go:build windows

package offboard

import (
	"errors"
	"os"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestProfilePathOfCurrentUser(t *testing.T) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sid := u.User.Sid.String()
	if !strings.HasPrefix(sid, "S-1-5-21-") {
		t.Skipf("running as %s (not a user account)", sid)
	}
	got, err := ProfilePath(sid)
	if err != nil {
		t.Fatal(err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(got, home) {
		t.Fatalf("profile %q, home %q", got, home)
	}
}

func TestProfilePathUnknownSID(t *testing.T) {
	if _, err := ProfilePath("S-1-5-21-1-2-3-999999"); !errors.Is(err, ErrNoProfile) {
		t.Fatalf("got %v, want ErrNoProfile", err)
	}
}
