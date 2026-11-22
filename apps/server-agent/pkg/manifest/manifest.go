// Package manifest defines the signed release manifest (docs/UPDATES.md §1 step 6, §3)
// and the code to build, sign and verify it.
//
// Signing scheme (ADR-015): the manifest body is serialised once to JSON
// (manifest.json) and signed as exact bytes with ed25519 over
// signingContext || body. The detached signature lives in manifest.sig.json.
// Verifiers check the signature over the raw bytes BEFORE parsing, so no JSON
// canonicalisation is needed and a tampered byte anywhere fails.
package manifest

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// SchemaVersion is the manifest/signature format version.
const SchemaVersion = 1

// signingContext provides domain separation so a manifest signature can never be
// replayed as a signature over some other kind of document.
const signingContext = "offmanual-release-manifest-v1\n"

// AlgEd25519 is the only supported signature algorithm.
const AlgEd25519 = "ed25519"

// Severity of a release.
type Severity string

// Allowed severities.
const (
	SeverityNormal   Severity = "normal"
	SeveritySecurity Severity = "security"
)

// File is one file inside the release payload.
type File struct {
	Path   string `json:"path"` // forward-slash relative path, validated by SafePath
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Payload describes the zip archive that carries the files.
type Payload struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Manifest is the body of manifest.json.
type Manifest struct {
	Schema          int        `json:"schema"`
	Version         string     `json:"version"`
	Commit          string     `json:"commit"`
	CreatedAt       time.Time  `json:"createdAt"`
	Severity        Severity   `json:"severity"`
	DeadlineAt      *time.Time `json:"deadlineAt,omitempty"`
	MinAgentVersion string     `json:"minAgentVersion"`
	OpenClawVersion string     `json:"openclawVersion"`
	NodeVersion     string     `json:"nodeVersion"`
	KeyID           string     `json:"keyId"`
	Payload         Payload    `json:"payload"`
	Files           []File     `json:"files"`
}

// Signature is the body of manifest.sig.json.
type Signature struct {
	Schema int    `json:"schema"`
	Alg    string `json:"alg"`
	KeyID  string `json:"keyId"`
	Sig    string `json:"sig"` // base64 (std) ed25519 signature
}

var (
	semverRe = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$`)
	sha256Re = regexp.MustCompile(`^[0-9a-f]{64}$`)
	keyIDRe  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,63}$`)
)

// Common verification errors. Callers can errors.Is against these.
var (
	ErrUnknownKey     = errors.New("manifest signed with an unknown or revoked key")
	ErrBadSignature   = errors.New("manifest signature does not verify")
	ErrKeyIDMismatch  = errors.New("manifest keyId does not match signature keyId")
	ErrHashMismatch   = errors.New("hash mismatch")
	ErrUnexpectedFile = errors.New("file not listed in manifest")
	ErrMissingFile    = errors.New("file listed in manifest is missing")
)

// Validate checks every field. It does not check the signature or files on disk.
func (m *Manifest) Validate() error {
	if m.Schema != SchemaVersion {
		return fmt.Errorf("unsupported manifest schema %d", m.Schema)
	}
	if !semverRe.MatchString(m.Version) {
		return fmt.Errorf("version %q is not semver", m.Version)
	}
	if !semverRe.MatchString(m.MinAgentVersion) {
		return fmt.Errorf("minAgentVersion %q is not semver", m.MinAgentVersion)
	}
	if m.OpenClawVersion == "" || m.NodeVersion == "" {
		return errors.New("openclawVersion and nodeVersion are required")
	}
	if m.Commit == "" {
		return errors.New("commit is required")
	}
	if m.CreatedAt.IsZero() {
		return errors.New("createdAt is required")
	}
	switch m.Severity {
	case SeverityNormal:
		if m.DeadlineAt != nil {
			return errors.New("deadlineAt is only allowed on security releases")
		}
	case SeveritySecurity:
		if m.DeadlineAt == nil {
			return errors.New("security releases need deadlineAt")
		}
		if !m.DeadlineAt.After(m.CreatedAt) {
			return errors.New("deadlineAt must be after createdAt")
		}
	default:
		return fmt.Errorf("unknown severity %q", m.Severity)
	}
	if !keyIDRe.MatchString(m.KeyID) {
		return fmt.Errorf("keyId %q is invalid", m.KeyID)
	}
	if err := SafePath(m.Payload.Name); err != nil || strings.Contains(m.Payload.Name, "/") {
		return fmt.Errorf("payload name %q is invalid", m.Payload.Name)
	}
	if !sha256Re.MatchString(m.Payload.SHA256) || m.Payload.Size <= 0 {
		return errors.New("payload sha256/size invalid")
	}
	if len(m.Files) == 0 {
		return errors.New("manifest lists no files")
	}
	seen := make(map[string]bool, len(m.Files))
	for i, f := range m.Files {
		if err := SafePath(f.Path); err != nil {
			return fmt.Errorf("file %d: %w", i, err)
		}
		key := strings.ToLower(f.Path) // Windows paths are case-insensitive
		if seen[key] {
			return fmt.Errorf("duplicate file path %q", f.Path)
		}
		seen[key] = true
		if !sha256Re.MatchString(f.SHA256) {
			return fmt.Errorf("file %q: sha256 invalid", f.Path)
		}
		if f.Size < 0 {
			return fmt.Errorf("file %q: negative size", f.Path)
		}
		if i > 0 && m.Files[i-1].Path >= f.Path {
			return errors.New("files must be sorted by path")
		}
	}
	return nil
}

var windowsReserved = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true, "COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true, "LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
}

// SafePath rejects any path that could escape the target directory or misbehave on
// Windows: absolute paths, drive letters, backslashes, "." and ".." segments,
// alternate data streams, reserved device names, control characters and
// segments ending in a dot or space.
func SafePath(p string) error {
	if p == "" {
		return errors.New("empty path")
	}
	if len(p) > 240 {
		return fmt.Errorf("path too long: %q", p)
	}
	if strings.ContainsAny(p, "\\:*?\"<>|") {
		return fmt.Errorf("path %q contains a forbidden character", p)
	}
	if strings.HasPrefix(p, "/") {
		return fmt.Errorf("path %q is absolute", p)
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("path %q contains a control character", p)
		}
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return fmt.Errorf("path %q has an empty, '.' or '..' segment", p)
		}
		if strings.HasSuffix(seg, ".") || strings.HasSuffix(seg, " ") {
			return fmt.Errorf("path %q has a segment ending in '.' or space", p)
		}
		base := strings.ToUpper(seg)
		if i := strings.IndexByte(base, '.'); i >= 0 {
			base = base[:i]
		}
		if windowsReserved[base] {
			return fmt.Errorf("path %q uses a reserved Windows name", p)
		}
	}
	return nil
}

// Marshal serialises a validated manifest to the exact bytes that get signed.
func Marshal(m *Manifest) ([]byte, error) {
	if err := m.Validate(); err != nil {
		return nil, err
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// Sign produces a detached signature over the exact manifest bytes.
func Sign(body []byte, keyID string, priv ed25519.PrivateKey) (Signature, error) {
	if !keyIDRe.MatchString(keyID) {
		return Signature{}, fmt.Errorf("keyId %q is invalid", keyID)
	}
	if len(priv) != ed25519.PrivateKeySize {
		return Signature{}, errors.New("invalid ed25519 private key")
	}
	sig := ed25519.Sign(priv, signedMessage(body))
	return Signature{Schema: SchemaVersion, Alg: AlgEd25519, KeyID: keyID, Sig: base64.StdEncoding.EncodeToString(sig)}, nil
}

// Keyring maps key IDs to trusted public keys. Revoked keys are simply absent.
type Keyring map[string]ed25519.PublicKey

// Verify checks the signature over the raw manifest bytes with a trusted key, then
// parses (rejecting unknown fields) and validates the manifest.
func Verify(body []byte, sig Signature, keys Keyring) (*Manifest, error) {
	if sig.Schema != SchemaVersion || sig.Alg != AlgEd25519 {
		return nil, fmt.Errorf("unsupported signature schema %d / alg %q", sig.Schema, sig.Alg)
	}
	pub, ok := keys[sig.KeyID]
	if !ok || len(pub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("%w: %q", ErrUnknownKey, sig.KeyID)
	}
	raw, err := base64.StdEncoding.DecodeString(sig.Sig)
	if err != nil || len(raw) != ed25519.SignatureSize {
		return nil, ErrBadSignature
	}
	if !ed25519.Verify(pub, signedMessage(body), raw) {
		return nil, ErrBadSignature
	}
	m, err := Parse(body)
	if err != nil {
		return nil, err
	}
	if m.KeyID != sig.KeyID {
		return nil, ErrKeyIDMismatch
	}
	return m, nil
}

// Parse decodes and validates manifest bytes WITHOUT checking a signature. Only use
// it on bytes whose signature was already verified, or in tooling.
func Parse(body []byte) (*Manifest, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var m Manifest
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("manifest JSON: %w", err)
	}
	if dec.More() {
		return nil, errors.New("manifest JSON has trailing data")
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// ParseSignature decodes manifest.sig.json strictly.
func ParseSignature(b []byte) (Signature, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var s Signature
	if err := dec.Decode(&s); err != nil {
		return Signature{}, fmt.Errorf("signature JSON: %w", err)
	}
	return s, nil
}

// ParsePublicKey decodes a base64 (std) ed25519 public key.
func ParsePublicKey(b64 string) (ed25519.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, errors.New("public key must be 32 bytes, base64")
	}
	return ed25519.PublicKey(raw), nil
}

// ParsePrivateKeySeed decodes a base64 (std) 32-byte ed25519 seed.
func ParsePrivateKeySeed(b64 string) (ed25519.PrivateKey, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil || len(raw) != ed25519.SeedSize {
		return nil, errors.New("private key seed must be 32 bytes, base64")
	}
	return ed25519.NewKeyFromSeed(raw), nil
}

func signedMessage(body []byte) []byte {
	msg := make([]byte, 0, len(signingContext)+len(body))
	msg = append(msg, signingContext...)
	return append(msg, body...)
}

func sortFiles(files []File) {
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
}

func hexSum(sum []byte) string { return hex.EncodeToString(sum) }
