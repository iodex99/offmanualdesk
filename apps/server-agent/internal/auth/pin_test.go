package auth

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// Cheap parameters keep the tests fast; production uses DefaultArgon.
var testArgon = ArgonParams{Memory: 8 * 1024, Time: 1, Threads: 1, KeyLen: 32, SaltLen: 16}

func TestValidatePIN(t *testing.T) {
	for _, ok := range []string{"4821", "907315", "13579135", "2468"} {
		if err := ValidatePIN(ok); err != nil {
			t.Errorf("%q rejected: %v", ok, err)
		}
	}
	format := []string{"", "123", "123456789", "12a4", " 4821", "４８２１"}
	for _, p := range format {
		if err := ValidatePIN(p); !errors.Is(err, ErrPINFormat) {
			t.Errorf("%q: want ErrPINFormat, got %v", p, err)
		}
	}
	weak := []string{"0000", "1111", "1234", "4321", "7890", "8901", "9876", "0987", "123456", "1212", "2580"}
	for _, p := range weak {
		if err := ValidatePIN(p); !errors.Is(err, ErrPINWeak) {
			t.Errorf("%q: want ErrPINWeak, got %v", p, err)
		}
	}
}

func TestHashAndVerifyPIN(t *testing.T) {
	h, err := HashPIN("4821", testArgon)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$m=8192,t=1,p=1$") {
		t.Fatalf("unexpected encoding %q", h)
	}
	rehash, err := VerifyPIN(h, "4821")
	if err != nil {
		t.Fatalf("correct PIN rejected: %v", err)
	}
	if !rehash {
		t.Fatal("weak test parameters should ask for a rehash")
	}
	if _, err := VerifyPIN(h, "4822"); !errors.Is(err, ErrPINWrong) {
		t.Fatalf("wrong PIN: want ErrPINWrong, got %v", err)
	}
	h2, _ := HashPIN("4821", testArgon)
	if h == h2 {
		t.Fatal("same PIN hashed twice gives the same hash: salt missing")
	}
}

func TestHashPINRefusesInvalid(t *testing.T) {
	if _, err := HashPIN("1234", testArgon); !errors.Is(err, ErrPINWeak) {
		t.Fatalf("want ErrPINWeak, got %v", err)
	}
}

func TestDefaultParamsNoRehash(t *testing.T) {
	if testing.Short() {
		t.Skip("64 MiB argon2id in -short mode")
	}
	h, err := HashPIN("907315", DefaultArgon)
	if err != nil {
		t.Fatal(err)
	}
	rehash, err := VerifyPIN(h, "907315")
	if err != nil || rehash {
		t.Fatalf("default params: rehash=%v err=%v", rehash, err)
	}
}

func TestVerifyPINRejectsMalformedOrHostileHashes(t *testing.T) {
	good, _ := HashPIN("4821", testArgon)
	parts := strings.Split(good, "$")
	cases := map[string]string{
		"empty":        "",
		"bcrypt":       "$2a$10$abcdefghijklmnopqrstuv",
		"argon2i":      strings.Replace(good, "argon2id", "argon2i", 1),
		"version":      strings.Replace(good, "v=19", "v=16", 1),
		"huge memory":  "$" + strings.Join([]string{"argon2id", "v=19", "m=4194304,t=1,p=1", parts[4], parts[5]}, "$"),
		"zero time":    "$" + strings.Join([]string{"argon2id", "v=19", "m=8192,t=0,p=1", parts[4], parts[5]}, "$"),
		"bad salt":     "$" + strings.Join([]string{"argon2id", "v=19", parts[3], "!!", parts[5]}, "$"),
		"short key":    "$" + strings.Join([]string{"argon2id", "v=19", parts[3], parts[4], "AAAA"}, "$"),
		"extra fields": good + "$x",
	}
	for name, h := range cases {
		if _, err := VerifyPIN(h, "4821"); !errors.Is(err, ErrHashBad) {
			t.Errorf("%s: want ErrHashBad, got %v", name, err)
		}
	}
}

func TestLockoutPINThenCode(t *testing.T) {
	now := time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)
	var a Attempts
	for i := 1; i <= 2; i++ {
		if out := a.PINFailed(now); out.NeedDailyCode {
			t.Fatalf("daily code demanded after %d PIN failures", i)
		}
	}
	if out := a.PINFailed(now); !out.NeedDailyCode {
		t.Fatal("3rd wrong PIN must demand the daily code")
	}
	if a.PINAllowed(now) {
		t.Fatal("PIN still allowed after 3 failures")
	}
	a.CodeSucceeded()
	if !a.PINAllowed(now) {
		t.Fatal("correct daily code must re-enable the PIN")
	}
}

func TestLockoutAfterFiveCodes(t *testing.T) {
	now := time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)
	var a Attempts
	for i := 1; i <= 4; i++ {
		if out := a.CodeFailed(now); out.AlertAdmin || !out.LockedUntil.IsZero() {
			t.Fatalf("locked after %d failures", i)
		}
	}
	out := a.CodeFailed(now)
	if !out.AlertAdmin || !out.LockedUntil.Equal(now.Add(15*time.Minute)) {
		t.Fatalf("5th failure: %+v", out)
	}
	if !a.LockedOut(now.Add(14*time.Minute)) || a.PINAllowed(now.Add(time.Minute)) {
		t.Fatal("must stay locked for 15 minutes, PIN included")
	}
	// Further wrong codes during the lockout don't extend it or re-alert.
	again := a.CodeFailed(now.Add(5 * time.Minute))
	if again.AlertAdmin || !again.LockedUntil.Equal(now.Add(15*time.Minute)) {
		t.Fatalf("during lockout: %+v", again)
	}
	if a.LockedOut(now.Add(15 * time.Minute)) {
		t.Fatal("lockout must end after 15 minutes")
	}
	// PIN failures during a lockout report the lockout end.
	if pf := a.PINFailed(now.Add(time.Minute)); !pf.LockedUntil.Equal(now.Add(15 * time.Minute)) {
		t.Fatalf("PIN during lockout: %+v", pf)
	}
}
