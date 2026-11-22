// Package secrets protects data at rest for the Server Agent (TOTP secrets, LLM key).
//
// On Windows it uses DPAPI with machine scope (CRYPTPROTECT_LOCAL_MACHINE) and a
// fixed application entropy. Machine-scope blobs can be decrypted by ANY local
// account that has the blob and the entropy (lab L10), so the real protection is
// the file ACL: C:\ProgramData\OffManual is SYSTEM + Administrators only
// (set by `server-agent install`). Never copy blobs anywhere users can read.
package secrets

import "errors"

// Protector encrypts and decrypts small secrets.
type Protector interface {
	Protect(plain []byte) ([]byte, error)
	Unprotect(blob []byte) ([]byte, error)
}

// ErrUnprotect means a blob could not be decrypted (corrupt, other machine, tampered).
var ErrUnprotect = errors.New("secret could not be decrypted")

// ErrEmpty means Protect was given nothing to protect (always a caller bug).
var ErrEmpty = errors.New("refusing to protect an empty secret")

// entropy separates our blobs from any other DPAPI user on the machine.
var entropy = []byte("offmanual-server-agent/secrets/v1")
