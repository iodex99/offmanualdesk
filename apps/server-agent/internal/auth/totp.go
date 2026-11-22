// Package auth verifies employee codes on the firm's server (ADR-006): the daily
// TOTP code, PINs after idle lock, and step-up codes. Verification is local, so it
// works when the internet is down.
//
// TOTP follows RFC 6238 on top of RFC 4226 HOTP (dynamic truncation), with the
// parameters every authenticator app supports: SHA-1, 6 digits, 30-second steps.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // RFC 6238 default; HMAC-SHA1 is not affected by SHA-1 collisions
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"
	"net/url"
	"strings"
	"time"
)

// Algorithm is the HMAC hash used by HOTP/TOTP.
type Algorithm string

// Supported algorithms. Off Manual enrols with SHA1 (authenticator-app default);
// SHA256/SHA512 exist for the RFC test vectors and future use.
const (
	SHA1   Algorithm = "SHA1"
	SHA256 Algorithm = "SHA256"
	SHA512 Algorithm = "SHA512"
)

// Defaults for enrolment.
const (
	DefaultDigits = 6
	DefaultPeriod = 30 * time.Second
	DefaultSkew   = 1 // accept one step either side (clock drift / slow typing)
	SecretBytes   = 20
	Issuer        = "Off Manual"
)

// Errors returned by Verify. Callers map them to plain-language messages.
var (
	ErrInvalidCode = errors.New("code is not valid")
	ErrReplayed    = errors.New("code was already used")
	ErrBadSecret   = errors.New("TOTP secret is malformed")
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// Params describes one TOTP configuration.
type Params struct {
	Algorithm Algorithm
	Digits    int
	Period    time.Duration
}

// Default returns the enrolment parameters.
func Default() Params { return Params{Algorithm: SHA1, Digits: DefaultDigits, Period: DefaultPeriod} }

func (p Params) hasher() (func() hash.Hash, error) {
	switch p.Algorithm {
	case SHA1, "":
		return sha1.New, nil
	case SHA256:
		return sha256.New, nil
	case SHA512:
		return sha512.New, nil
	default:
		return nil, fmt.Errorf("unsupported TOTP algorithm %q", p.Algorithm)
	}
}

func (p Params) validate() error {
	if p.Digits < 6 || p.Digits > 8 {
		return fmt.Errorf("TOTP digits must be 6..8, got %d", p.Digits)
	}
	if p.Period < time.Second {
		return errors.New("TOTP period must be at least one second")
	}
	_, err := p.hasher()
	return err
}

// NewSecret returns a fresh random secret (base32, no padding) for enrolment.
func NewSecret() (string, error) {
	buf := make([]byte, SecretBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate TOTP secret: %w", err)
	}
	return b32.EncodeToString(buf), nil
}

// DecodeSecret parses a base32 secret (case-insensitive, spaces and padding ignored).
func DecodeSecret(s string) ([]byte, error) {
	clean := strings.ToUpper(strings.NewReplacer(" ", "", "-", "", "=", "").Replace(s))
	key, err := b32.DecodeString(clean)
	if err != nil || len(key) < 10 {
		return nil, ErrBadSecret
	}
	return key, nil
}

// HOTP computes the RFC 4226 code for a counter.
func HOTP(key []byte, counter uint64, p Params) (string, error) {
	if err := p.validate(); err != nil {
		return "", err
	}
	h, _ := p.hasher()
	mac := hmac.New(h, key)
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	bin := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	mod := uint32(1)
	for i := 0; i < p.Digits; i++ {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", p.Digits, bin%mod), nil
}

// Counter returns the TOTP time step for t.
func Counter(t time.Time, p Params) uint64 {
	secs := t.Unix()
	if secs < 0 {
		return 0
	}
	return uint64(secs) / uint64(p.Period/time.Second) //nolint:gosec // secs checked non-negative
}

// TOTP computes the code valid at t.
func TOTP(key []byte, t time.Time, p Params) (string, error) {
	return HOTP(key, Counter(t, p), p)
}

// Verify checks code against the secret at time now, allowing skew steps either side.
// lastUsed is the highest counter already accepted for this secret (0 if none); any
// code at or below it is refused, so a code can be used only once (replay protection).
// On success it returns the matched counter, which the caller must persist as lastUsed.
func Verify(secret, code string, now time.Time, lastUsed uint64, skew int, p Params) (uint64, error) {
	if err := p.validate(); err != nil {
		return 0, err
	}
	key, err := DecodeSecret(secret)
	if err != nil {
		return 0, err
	}
	code = strings.TrimSpace(code)
	if len(code) != p.Digits || strings.Trim(code, "0123456789") != "" {
		return 0, ErrInvalidCode
	}
	if skew < 0 {
		skew = 0
	}
	cur := Counter(now, p)
	var matched uint64
	found := false
	// Check every candidate without early exit so timing doesn't reveal which step matched.
	for d := -skew; d <= skew; d++ {
		if d < 0 && uint64(-d) > cur {
			continue
		}
		c := uint64(int64(cur) + int64(d)) //nolint:gosec // bounds checked above
		want, _ := HOTP(key, c, p)
		if subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 && (!found || c > matched) {
			matched, found = c, true
		}
	}
	if !found {
		return 0, ErrInvalidCode
	}
	if lastUsed != 0 && matched <= lastUsed {
		return 0, ErrReplayed
	}
	return matched, nil
}

// ProvisioningURI builds the otpauth:// URI shown as a QR code at enrolment.
// account is the employee's sign-in email (their own data, shown in their own app).
func ProvisioningURI(secret, account string, p Params) string {
	label := url.PathEscape(Issuer + ":" + account)
	q := url.Values{}
	q.Set("secret", secret)
	q.Set("issuer", Issuer)
	q.Set("algorithm", string(p.Algorithm))
	q.Set("digits", fmt.Sprint(p.Digits))
	q.Set("period", fmt.Sprint(int(p.Period/time.Second)))
	return "otpauth://totp/" + label + "?" + q.Encode()
}
