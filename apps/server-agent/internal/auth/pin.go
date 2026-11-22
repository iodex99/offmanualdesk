package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// PIN rules (ADR-031): 4–8 digits, not trivially guessable. PINs only unlock
// after idle (F3); a wrong PIN three times forces the daily code.
const (
	MinPINLength = 4
	MaxPINLength = 8
)

// Argon2id parameters (RFC 9106 §4 second recommended option, reduced memory
// for a shared RDS host: PIN checks are rare, a few per employee per day).
type ArgonParams struct {
	Memory  uint32 // KiB
	Time    uint32
	Threads uint8
	KeyLen  uint32
	SaltLen int
}

// DefaultArgon is used for new hashes.
var DefaultArgon = ArgonParams{Memory: 64 * 1024, Time: 3, Threads: 2, KeyLen: 32, SaltLen: 16}

// PIN errors; map to plain messages in Desk.
var (
	ErrPINFormat = errors.New("PIN must be 4 to 8 digits")
	ErrPINWeak   = errors.New("PIN is too easy to guess")
	ErrPINWrong  = errors.New("PIN is not correct")
	ErrHashBad   = errors.New("stored PIN hash is malformed")
)

// ValidatePIN checks format and rejects trivial PINs (all one digit, straight
// ascending or descending runs, and a short list of common choices).
func ValidatePIN(pin string) error {
	if len(pin) < MinPINLength || len(pin) > MaxPINLength || strings.Trim(pin, "0123456789") != "" {
		return ErrPINFormat
	}
	same, up, down := true, true, true
	for i := 1; i < len(pin); i++ {
		d := int(pin[i]) - int(pin[i-1])
		same = same && d == 0
		up = up && (d == 1 || d == -9)
		down = down && (d == -1 || d == 9)
	}
	if same || up || down {
		return ErrPINWeak
	}
	switch pin {
	case "1212", "2580", "0852", "1122", "6969", "1004", "2000", "1010", "121212", "112233", "123123", "696969":
		return ErrPINWeak
	}
	return nil
}

// HashPIN returns a PHC-format argon2id hash: $argon2id$v=19$m=..,t=..,p=..$salt$hash
func HashPIN(pin string, p ArgonParams) (string, error) {
	if err := ValidatePIN(pin); err != nil {
		return "", err
	}
	salt := make([]byte, p.SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}
	key := argon2.IDKey([]byte(pin), salt, p.Time, p.Memory, p.Threads, p.KeyLen)
	enc := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, p.Memory, p.Time, p.Threads, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

// VerifyPIN checks pin against a stored hash in constant time. needsRehash is true
// when the hash used weaker parameters than DefaultArgon (re-hash on success).
func VerifyPIN(encoded, pin string) (needsRehash bool, err error) {
	p, salt, want, err := decodeHash(encoded)
	if err != nil {
		return false, err
	}
	got := argon2.IDKey([]byte(pin), salt, p.Time, p.Memory, p.Threads, uint32(len(want))) //nolint:gosec // len bounded by decode
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return false, ErrPINWrong
	}
	weaker := p.Memory < DefaultArgon.Memory || p.Time < DefaultArgon.Time || len(want) < int(DefaultArgon.KeyLen)
	return weaker, nil
}

func decodeHash(encoded string) (ArgonParams, []byte, []byte, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return ArgonParams{}, nil, nil, ErrHashBad
	}
	var v int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &v); err != nil || v != argon2.Version {
		return ArgonParams{}, nil, nil, ErrHashBad
	}
	var p ArgonParams
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.Memory, &p.Time, &p.Threads); err != nil {
		return ArgonParams{}, nil, nil, ErrHashBad
	}
	// Bounds stop a tampered hash from asking for absurd memory or zero work.
	if p.Memory < 8*1024 || p.Memory > 1024*1024 || p.Time < 1 || p.Time > 20 || p.Threads < 1 {
		return ArgonParams{}, nil, nil, ErrHashBad
	}
	enc := base64.RawStdEncoding
	salt, err1 := enc.DecodeString(parts[4])
	key, err2 := enc.DecodeString(parts[5])
	if err1 != nil || err2 != nil || len(salt) < 8 || len(key) < 16 || len(key) > 64 {
		return ArgonParams{}, nil, nil, ErrHashBad
	}
	return p, salt, key, nil
}
