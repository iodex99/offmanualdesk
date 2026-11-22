package auth

import (
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"
)

// RFC 4226 Appendix D: secret "12345678901234567890", counters 0..9, 6 digits.
func TestHOTPRFC4226Vectors(t *testing.T) {
	key := []byte("12345678901234567890")
	want := []string{"755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"}
	for i, w := range want {
		got, err := HOTP(key, uint64(i), Params{Algorithm: SHA1, Digits: 6, Period: 30 * time.Second})
		if err != nil || got != w {
			t.Errorf("counter %d: got %q (%v), want %q", i, got, err, w)
		}
	}
}

// RFC 6238 Appendix B: 8 digits, 30 s, seeds of 20/32/64 bytes.
func TestTOTPRFC6238Vectors(t *testing.T) {
	seeds := map[Algorithm][]byte{
		SHA1:   []byte("12345678901234567890"),
		SHA256: []byte("12345678901234567890123456789012"),
		SHA512: []byte("1234567890123456789012345678901234567890123456789012345678901234"),
	}
	vectors := []struct {
		unix int64
		alg  Algorithm
		code string
	}{
		{59, SHA1, "94287082"}, {59, SHA256, "46119246"}, {59, SHA512, "90693936"},
		{1111111109, SHA1, "07081804"}, {1111111109, SHA256, "68084774"}, {1111111109, SHA512, "25091201"},
		{1111111111, SHA1, "14050471"}, {1111111111, SHA256, "67062674"}, {1111111111, SHA512, "99943326"},
		{1234567890, SHA1, "89005924"}, {1234567890, SHA256, "91819424"}, {1234567890, SHA512, "93441116"},
		{2000000000, SHA1, "69279037"}, {2000000000, SHA256, "90698825"}, {2000000000, SHA512, "38618901"},
		{20000000000, SHA1, "65353130"}, {20000000000, SHA256, "77737706"}, {20000000000, SHA512, "47863826"},
	}
	for _, v := range vectors {
		got, err := TOTP(seeds[v.alg], time.Unix(v.unix, 0), Params{Algorithm: v.alg, Digits: 8, Period: 30 * time.Second})
		if err != nil || got != v.code {
			t.Errorf("%s @%d: got %q (%v), want %q", v.alg, v.unix, got, err, v.code)
		}
	}
}

func TestVerifyAcceptsSkewAndRejectsReplay(t *testing.T) {
	secret, err := NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	key, _ := DecodeSecret(secret)
	p := Default()
	now := time.Date(2026, 11, 22, 9, 30, 15, 0, time.UTC)

	prev, _ := TOTP(key, now.Add(-30*time.Second), p)
	c, err := Verify(secret, prev, now, 0, DefaultSkew, p)
	if err != nil {
		t.Fatalf("previous step rejected: %v", err)
	}
	// The same code again is a replay.
	if _, err := Verify(secret, prev, now, c, DefaultSkew, p); !errors.Is(err, ErrReplayed) {
		t.Fatalf("want ErrReplayed, got %v", err)
	}
	// The current code is a newer counter: accepted.
	cur, _ := TOTP(key, now, p)
	c2, err := Verify(secret, cur, now, c, DefaultSkew, p)
	if err != nil || c2 != c+1 {
		t.Fatalf("current code: counter %d err %v", c2, err)
	}
	// Two steps away is outside the window.
	old, _ := TOTP(key, now.Add(-90*time.Second), p)
	if _, err := Verify(secret, old, now, 0, DefaultSkew, p); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("old code: want ErrInvalidCode, got %v", err)
	}
	// Skew 0 accepts only the current step.
	if _, err := Verify(secret, prev, now, 0, 0, p); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("skew 0: want ErrInvalidCode, got %v", err)
	}
}

func TestVerifyRejectsMalformedInput(t *testing.T) {
	secret, _ := NewSecret()
	now := time.Now()
	for _, code := range []string{"", "12345", "1234567", "12a456", "１２３４５６", "-12345"} {
		if _, err := Verify(secret, code, now, 0, 1, Default()); !errors.Is(err, ErrInvalidCode) {
			t.Errorf("code %q: want ErrInvalidCode, got %v", code, err)
		}
	}
	for _, s := range []string{"", "!!!!", "MZXW6"} {
		if _, err := Verify(s, "123456", now, 0, 1, Default()); !errors.Is(err, ErrBadSecret) {
			t.Errorf("secret %q: want ErrBadSecret, got %v", s, err)
		}
	}
	if _, err := Verify(secret, "123456", now, 0, 1, Params{Algorithm: "MD5", Digits: 6, Period: 30 * time.Second}); err == nil {
		t.Error("MD5 accepted")
	}
	if _, err := Verify(secret, "123456", now, 0, 1, Params{Algorithm: SHA1, Digits: 4, Period: 30 * time.Second}); err == nil {
		t.Error("4 digits accepted")
	}
}

func TestVerifyTrimsSpacesAndSecretFormatting(t *testing.T) {
	secret, _ := NewSecret()
	key, _ := DecodeSecret(secret)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	code, _ := TOTP(key, now, Default())
	spaced := strings.ToLower(secret[:8]) + " " + secret[8:]
	if _, err := Verify(spaced, " "+code+" ", now, 0, 1, Default()); err != nil {
		t.Fatalf("formatted secret/code rejected: %v", err)
	}
}

func TestVerifyNearEpochDoesNotUnderflow(t *testing.T) {
	secret, _ := NewSecret()
	key, _ := DecodeSecret(secret)
	at := time.Unix(5, 0)
	code, _ := TOTP(key, at, Default())
	if _, err := Verify(secret, code, at, 0, 2, Default()); err != nil {
		t.Fatalf("epoch code rejected: %v", err)
	}
	if Counter(time.Unix(-100, 0), Default()) != 0 {
		t.Fatal("negative time must map to counter 0")
	}
}

func TestNewSecretIsRandomAndDecodable(t *testing.T) {
	a, _ := NewSecret()
	b, _ := NewSecret()
	if a == b {
		t.Fatal("secrets repeat")
	}
	key, err := DecodeSecret(a)
	if err != nil || len(key) != SecretBytes {
		t.Fatalf("decode: %v len %d", err, len(key))
	}
}

func TestProvisioningURI(t *testing.T) {
	u, err := url.Parse(ProvisioningURI("JBSWY3DPEHPK3PXP", "asha@mehta-ca.in", Default()))
	if err != nil {
		t.Fatal(err)
	}
	if u.Scheme != "otpauth" || u.Host != "totp" {
		t.Fatalf("bad uri %s", u)
	}
	if got, _ := url.PathUnescape(strings.TrimPrefix(u.EscapedPath(), "/")); got != "Off Manual:asha@mehta-ca.in" {
		t.Fatalf("label %q", got)
	}
	q := u.Query()
	if q.Get("secret") != "JBSWY3DPEHPK3PXP" || q.Get("issuer") != "Off Manual" || q.Get("digits") != "6" || q.Get("period") != "30" || q.Get("algorithm") != "SHA1" {
		t.Fatalf("query %v", q)
	}
}
