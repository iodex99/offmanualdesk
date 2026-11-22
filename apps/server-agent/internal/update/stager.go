// Package update stages signed releases side by side (docs/UPDATES.md §3, ADR-010,
// ADR-015). Staging never touches the running version: it only adds
// versions\<semver>\ after every check passes. Switching is Desk's restart-to-update.
package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"offmanual/desk/server-agent/pkg/manifest"
)

// Release is what the console assigns (GET /api/agent/releases).
type Release struct {
	Version       string `json:"version"`
	ManifestURL   string `json:"manifestUrl"`
	PayloadSHA256 string `json:"payloadSha256"`
	KeyID         string `json:"keyId"`
}

// StateRecorder persists staging progress (agent.db `updates`).
type StateRecorder interface {
	SetUpdateState(ctx context.Context, version, state, errMsg string) error
}

// Stager downloads, verifies and unpacks releases.
type Stager struct {
	VersionsDir  string // C:\Program Files\OffManual\versions
	StagingDir   string // C:\ProgramData\OffManual\staging
	Keys         manifest.Keyring
	AgentVersion string
	HTTP         *http.Client
	States       StateRecorder
}

// Errors callers can match.
var (
	ErrNeedsNewerAgent = errors.New("release needs a newer Server Agent")
	ErrMismatch        = errors.New("release does not match what the console assigned")
)

const maxManifestBytes = 8 << 20

func (s *Stager) client() *http.Client {
	if s.HTTP != nil {
		return s.HTTP
	}
	return &http.Client{Timeout: 30 * time.Minute}
}

// Stage makes versions\<rel.Version> exist and verified. It is idempotent.
func (s *Stager) Stage(ctx context.Context, rel Release) (err error) {
	final := filepath.Join(s.VersionsDir, rel.Version)
	defer func() {
		state, msg := "staged", ""
		if err != nil {
			state, msg = "failed", err.Error()
		}
		if s.States != nil {
			_ = s.States.SetUpdateState(ctx, rel.Version, state, msg)
		}
	}()
	if s.States != nil {
		_ = s.States.SetUpdateState(ctx, rel.Version, "downloading", "")
	}

	body, err := s.get(ctx, rel.ManifestURL, maxManifestBytes)
	if err != nil {
		return fmt.Errorf("manifest: %w", err)
	}
	sigURL, err := sibling(rel.ManifestURL, "manifest.sig.json")
	if err != nil {
		return err
	}
	sigBody, err := s.get(ctx, sigURL, 64<<10)
	if err != nil {
		return fmt.Errorf("signature: %w", err)
	}
	sig, err := manifest.ParseSignature(sigBody)
	if err != nil {
		return err
	}
	m, err := manifest.Verify(body, sig, s.Keys)
	if err != nil {
		return err
	}
	if m.Version != rel.Version || m.Payload.SHA256 != rel.PayloadSHA256 || (rel.KeyID != "" && m.KeyID != rel.KeyID) {
		return ErrMismatch
	}
	if cmp, err := manifest.CompareVersions(s.AgentVersion, m.MinAgentVersion); err == nil && cmp < 0 {
		return fmt.Errorf("%w: needs %s, have %s", ErrNeedsNewerAgent, m.MinAgentVersion, s.AgentVersion)
	}

	if _, err := os.Stat(final); err == nil {
		if verr := manifest.VerifyDir(final, m); verr == nil {
			return nil // already staged and intact
		}
		// Present but changed: never trust it. Move it aside for inspection.
		if err := os.Rename(final, final+".bad-"+time.Now().UTC().Format("20060102T150405")); err != nil {
			return fmt.Errorf("quarantine tampered %s: %w", final, err)
		}
	}

	if err := os.MkdirAll(s.StagingDir, 0o755); err != nil {
		return err
	}
	payloadURL, err := sibling(rel.ManifestURL, m.Payload.Name)
	if err != nil {
		return err
	}
	zipPath := filepath.Join(s.StagingDir, m.Payload.Name)
	if err := s.download(ctx, payloadURL, zipPath, m.Payload.Size, m.Payload.SHA256); err != nil {
		return fmt.Errorf("payload: %w", err)
	}
	defer func() { _ = os.Remove(zipPath) }()

	tmp := final + ".staging"
	_ = os.RemoveAll(tmp)
	if err := manifest.ExtractZip(zipPath, tmp, m); err != nil {
		return err
	}
	if err := manifest.VerifyDir(tmp, m); err != nil {
		_ = os.RemoveAll(tmp)
		return err
	}
	// Keep the signed manifest next to (not inside) the version folder for later re-verification.
	if err := os.WriteFile(filepath.Join(s.VersionsDir, rel.Version+".manifest.json"), body, 0o644); err != nil {
		_ = os.RemoveAll(tmp)
		return err
	}
	return os.Rename(tmp, final)
}

func (s *Stager) get(ctx context.Context, u string, limit int64) ([]byte, error) {
	if err := checkURL(u); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errors.New("response too large")
	}
	return b, nil
}

func (s *Stager) download(ctx context.Context, u, dest string, size int64, wantSHA string) error {
	if err := checkURL(u); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	resp, err := s.client().Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	part := dest + ".part"
	f, err := os.Create(part)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, size+1))
	closeErr := f.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(part)
		return errors.Join(copyErr, closeErr)
	}
	if n != size || hex.EncodeToString(h.Sum(nil)) != wantSHA {
		_ = os.Remove(part)
		return manifest.ErrHashMismatch
	}
	return os.Rename(part, dest)
}

// checkURL allows HTTPS only (plain HTTP to 127.0.0.1 is allowed for tests).
func checkURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if u.Scheme == "https" || (u.Scheme == "http" && u.Hostname() == "127.0.0.1") {
		return nil
	}
	return fmt.Errorf("refusing non-HTTPS release URL %s", u.Redacted())
}

// sibling replaces the last path segment of a URL (manifest.json → other file).
func sibling(manifestURL, name string) (string, error) {
	if strings.ContainsAny(name, `/\`) || name == "" || name == "." || name == ".." {
		return "", fmt.Errorf("bad file name %q", name)
	}
	u, err := url.Parse(manifestURL)
	if err != nil {
		return "", err
	}
	u.Path = path.Join(path.Dir(u.Path), name)
	return u.String(), nil
}
