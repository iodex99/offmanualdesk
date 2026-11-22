// Command sign-manifest builds, signs and verifies Off Manual release manifests
// (docs/UPDATES.md §1 step 6). The release workflow (.github/workflows/release.yml)
// calls it; Dwahnil uses `keygen` once to create the release-signing key.
//
//	sign-manifest keygen  -key-id om-rel-2026a -out-public om-rel-2026a.pub
//	sign-manifest build   -dir payload -version 1.2.3 -commit <sha> -openclaw <v> -node <v>
//	                      -min-agent 1.0.0 -key-id om-rel-2026a -zip out/payload.zip -out out/manifest.json
//	sign-manifest sign    -manifest out/manifest.json -out out/manifest.sig.json   (key in $RELEASE_SIGNING_KEY)
//	sign-manifest verify  -manifest out/manifest.json -sig out/manifest.sig.json -pubkey-file k.pub -zip out/payload.zip
//
// The private key is a base64 ed25519 seed. It is only ever read from an
// environment variable (never a flag, so it can't land in shell history or CI logs).
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"offmanual/desk/server-agent/pkg/manifest"
)

const defaultKeyEnv = "RELEASE_SIGNING_KEY"

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr, os.Getenv))
}

func run(args []string, stdout, stderr io.Writer, getenv func(string) string) int {
	if len(args) == 0 {
		_, _ = fmt.Fprintln(stderr, "usage: sign-manifest keygen|build|sign|verify [flags]")
		return 2
	}
	var err error
	switch args[0] {
	case "keygen":
		err = cmdKeygen(args[1:], stdout)
	case "build":
		err = cmdBuild(args[1:], stdout)
	case "sign":
		err = cmdSign(args[1:], stdout, getenv)
	case "verify":
		err = cmdVerify(args[1:], stdout)
	default:
		err = fmt.Errorf("unknown command %q", args[0])
	}
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "sign-manifest %s: %v\n", args[0], err)
		return 1
	}
	return 0
}

func cmdKeygen(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("keygen", flag.ContinueOnError)
	keyID := fs.String("key-id", "", "key ID, e.g. om-rel-2026a")
	outPub := fs.String("out-public", "", "write the public key (base64) to this file")
	outPriv := fs.String("out-private", "", "write the private seed (base64) to this file; keep it OUT of the repo")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *keyID == "" || *outPub == "" || *outPriv == "" {
		return errors.New("-key-id, -out-public and -out-private are required")
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	if err := os.WriteFile(*outPub, []byte(base64.StdEncoding.EncodeToString(pub)+"\n"), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(*outPriv, []byte(base64.StdEncoding.EncodeToString(priv.Seed())+"\n"), 0o600); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "key %s: public key written to %s, private seed to %s\n", *keyID, *outPub, *outPriv)
	_, _ = fmt.Fprintln(stdout, "Store the private seed as the GitHub secret RELEASE_SIGNING_KEY, then delete the file.")
	return nil
}

func cmdBuild(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("build", flag.ContinueOnError)
	dir := fs.String("dir", "", "payload directory (becomes versions/<semver>/)")
	ver := fs.String("version", "", "release semver")
	commit := fs.String("commit", "", "git commit SHA")
	openclaw := fs.String("openclaw", "", "pinned OpenClaw version")
	node := fs.String("node", "", "bundled Node version")
	minAgent := fs.String("min-agent", "", "minimum Server Agent version that may stage this release")
	severity := fs.String("severity", "normal", "normal|security")
	deadline := fs.String("deadline", "", "RFC3339 deadline (security releases only)")
	keyID := fs.String("key-id", "", "signing key ID")
	zipOut := fs.String("zip", "", "payload zip output path")
	out := fs.String("out", "", "manifest.json output path")
	created := fs.String("created-at", "", "RFC3339 creation time (default now; set for reproducible builds)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	for name, v := range map[string]string{"dir": *dir, "version": *ver, "commit": *commit, "openclaw": *openclaw, "node": *node, "min-agent": *minAgent, "key-id": *keyID, "zip": *zipOut, "out": *out} {
		if v == "" {
			return fmt.Errorf("-%s is required", name)
		}
	}
	createdAt := time.Now().UTC().Truncate(time.Second)
	if *created != "" {
		t, err := time.Parse(time.RFC3339, *created)
		if err != nil {
			return fmt.Errorf("-created-at: %w", err)
		}
		createdAt = t.UTC()
	}
	files, err := manifest.ListDir(*dir)
	if err != nil {
		return err
	}
	if err := manifest.WriteZip(*dir, files, *zipOut); err != nil {
		return err
	}
	sum, size, err := manifest.HashFile(*zipOut)
	if err != nil {
		return err
	}
	m := &manifest.Manifest{
		Schema: manifest.SchemaVersion, Version: strings.TrimPrefix(*ver, "v"), Commit: *commit,
		CreatedAt: createdAt, Severity: manifest.Severity(*severity), MinAgentVersion: *minAgent,
		OpenClawVersion: *openclaw, NodeVersion: *node, KeyID: *keyID,
		Payload: manifest.Payload{Name: filepath.Base(*zipOut), SHA256: sum, Size: size},
		Files:   files,
	}
	if *deadline != "" {
		t, err := time.Parse(time.RFC3339, *deadline)
		if err != nil {
			return fmt.Errorf("-deadline: %w", err)
		}
		t = t.UTC()
		m.DeadlineAt = &t
	}
	body, err := manifest.Marshal(m)
	if err != nil {
		return err
	}
	if err := os.WriteFile(*out, body, 0o644); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "manifest %s: %d files, payload %s (%d bytes, sha256 %s)\n", m.Version, len(files), m.Payload.Name, size, sum)
	return nil
}

func cmdSign(args []string, stdout io.Writer, getenv func(string) string) error {
	fs := flag.NewFlagSet("sign", flag.ContinueOnError)
	in := fs.String("manifest", "", "manifest.json to sign")
	out := fs.String("out", "", "signature output path (manifest.sig.json)")
	keyEnv := fs.String("key-env", defaultKeyEnv, "environment variable holding the base64 private seed")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *in == "" || *out == "" {
		return errors.New("-manifest and -out are required")
	}
	seed := getenv(*keyEnv)
	if seed == "" {
		return fmt.Errorf("environment variable %s is empty", *keyEnv)
	}
	priv, err := manifest.ParsePrivateKeySeed(seed)
	if err != nil {
		return err
	}
	body, err := os.ReadFile(*in)
	if err != nil {
		return err
	}
	m, err := manifest.Parse(body)
	if err != nil {
		return err
	}
	sig, err := manifest.Sign(body, m.KeyID, priv)
	if err != nil {
		return err
	}
	// Self-check: the signature must verify with the matching public key.
	pub := priv.Public().(ed25519.PublicKey)
	if _, err := manifest.Verify(body, sig, manifest.Keyring{m.KeyID: pub}); err != nil {
		return fmt.Errorf("self-verification failed: %w", err)
	}
	sb, err := json.MarshalIndent(sig, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(*out, append(sb, '\n'), 0o644); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "signed %s with key %s (public %s)\n", m.Version, m.KeyID, base64.StdEncoding.EncodeToString(pub))
	return nil
}

func cmdVerify(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	in := fs.String("manifest", "", "manifest.json")
	sigPath := fs.String("sig", "", "manifest.sig.json")
	pubFile := fs.String("pubkey-file", "", "file with the base64 public key for the manifest's keyId")
	zipPath := fs.String("zip", "", "optional payload zip to hash-check and test-extract")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *in == "" || *sigPath == "" || *pubFile == "" {
		return errors.New("-manifest, -sig and -pubkey-file are required")
	}
	body, err := os.ReadFile(*in)
	if err != nil {
		return err
	}
	sb, err := os.ReadFile(*sigPath)
	if err != nil {
		return err
	}
	sig, err := manifest.ParseSignature(sb)
	if err != nil {
		return err
	}
	pb, err := os.ReadFile(*pubFile)
	if err != nil {
		return err
	}
	pub, err := manifest.ParsePublicKey(string(pb))
	if err != nil {
		return err
	}
	m, err := manifest.Verify(body, sig, manifest.Keyring{sig.KeyID: pub})
	if err != nil {
		return err
	}
	if *zipPath != "" {
		if err := manifest.VerifyFileHash(*zipPath, m.Payload.SHA256, m.Payload.Size); err != nil {
			return err
		}
		tmp, err := os.MkdirTemp("", "om-verify-*")
		if err != nil {
			return err
		}
		defer func() { _ = os.RemoveAll(tmp) }()
		if err := manifest.ExtractZip(*zipPath, filepath.Join(tmp, "x"), m); err != nil {
			return err
		}
	}
	_, _ = fmt.Fprintf(stdout, "OK: %s signed by %s, %d files\n", m.Version, m.KeyID, len(m.Files))
	return nil
}
