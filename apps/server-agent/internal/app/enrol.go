package app

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"offmanual/desk/server-agent/internal/agent"
	"offmanual/desk/server-agent/internal/console"
	"offmanual/desk/server-agent/internal/preflight"
	"offmanual/desk/server-agent/internal/secrets"
	"offmanual/desk/server-agent/internal/store"
	"offmanual/desk/server-agent/internal/update"
	"offmanual/desk/server-agent/internal/version"
	"offmanual/desk/server-agent/pkg/manifest"
)

// Enrol registers this server with the console using a one-time code (F1 step 3).
// The server's ed25519 seed is stored DPAPI-protected in agent.db.
func Enrol(ctx context.Context, dataDir, consoleURL, code string, out io.Writer) error {
	if protector == nil {
		return ErrUnsupported
	}
	if dataDir == "" {
		dataDir = DefaultDataDir()
	}
	if err := PrepareDataDir(dataDir); err != nil {
		return err
	}
	st, err := store.Open(ctx, filepath.Join(dataDir, "agent.db"))
	if err != nil {
		return err
	}
	defer func() { _ = st.Close() }()
	if id, err := st.Meta(ctx, console.MetaServerID); err == nil && id != "" {
		return fmt.Errorf("this server is already enrolled as %s", id)
	}
	report := boundReport(preflight.Run(ctx, preflight.Standard(preflight.DefaultOptions())), enrolLimits)
	pf, err := json.Marshal(report)
	if err != nil {
		return err
	}
	host, _ := os.Hostname()
	c := &console.Client{BaseURL: strings.TrimRight(consoleURL, "/")}
	id, key, err := c.Enrol(ctx, code, sanitizeHost(host), version.Get().Version, pf)
	if err != nil {
		return err
	}
	prot, err := protector()
	if err != nil {
		return err
	}
	blob, err := prot.Protect(key.Seed())
	if err != nil {
		return err
	}
	for k, v := range map[string]string{
		console.MetaServerID:   id,
		console.MetaServerKey:  base64.StdEncoding.EncodeToString(blob),
		console.MetaConsoleURL: c.BaseURL,
	} {
		if err := st.SetMeta(ctx, k, v); err != nil {
			return err
		}
	}
	_, _ = fmt.Fprintf(out, "Enrolled as %s. Pre-flight: %s.\n", id, strings.ToUpper(string(report.Overall)))
	return nil
}

func sanitizeHost(h string) string {
	var b strings.Builder
	for _, r := range h {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		}
	}
	s := b.String()
	if s == "" || s[0] == '-' {
		s = "server" + s
	}
	if len(s) > 63 {
		s = s[:63]
	}
	return s
}

// loadIdentity returns a console client for an enrolled server, or nil if not enrolled.
func loadIdentity(ctx context.Context, st *store.Store, prot secrets.Protector) (*console.Client, error) {
	id, err := st.Meta(ctx, console.MetaServerID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	keyB64, err := st.Meta(ctx, console.MetaServerKey)
	if err != nil {
		return nil, err
	}
	base, err := st.Meta(ctx, console.MetaConsoleURL)
	if err != nil {
		return nil, err
	}
	blob, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil {
		return nil, err
	}
	seed, err := prot.Unprotect(blob)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("server key could not be read; re-enrol this server")
	}
	return &console.Client{BaseURL: base, ServerID: id, Key: ed25519.NewKeyFromSeed(seed)}, nil
}

// startSync launches the console loop if enrolled.
// startSync starts the console loop and returns the console client (nil when not enrolled).
func startSync(ctx context.Context, st *store.Store, prot secrets.Protector, log *slog.Logger, dataDir string) *console.Client {
	c, err := loadIdentity(ctx, st, prot)
	if err != nil {
		log.Error("console identity unavailable", "error", err.Error())
		return nil
	}
	if c == nil {
		log.Info("not enrolled with the console yet; run: server-agent enroll -console URL CODE")
		return nil
	}
	keys, err := manifest.TrustedKeys()
	if err != nil {
		log.Error("release keys unreadable; updates disabled", "error", err.Error())
	}
	var stager *update.Stager
	if err == nil {
		stager = &update.Stager{
			VersionsDir:  filepath.Join(installRoot(), "versions"),
			StagingDir:   filepath.Join(dataDir, "staging"),
			Keys:         keys,
			AgentVersion: version.Get().Version,
			States:       st,
		}
	}
	s := &console.Syncer{Client: c, Store: st, Log: log, AgentVersion: version.Get().Version, Stager: stager,
		Seats: func(ctx context.Context) int {
			n, _ := st.ActiveLeases(ctx, time.Now().Add(-time.Hour))
			return n
		}}
	go s.Run(ctx)
	return c
}

// binderFor redeems bind codes at the console (ADR-044). Console 4xx messages are
// already plain sentences for the employee.
func binderFor(c *console.Client) agent.Binder {
	return func(ctx context.Context, code, sid string) (agent.BoundEmployee, error) {
		ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		r, err := c.Bind(ctx, code, sid)
		var api *console.APIError
		if errors.As(err, &api) && api.Status >= 400 && api.Status < 500 && api.Message != "" && api.Status != 401 {
			return agent.BoundEmployee{}, agent.UserMessage(api.Message)
		}
		if err != nil {
			return agent.BoundEmployee{}, err
		}
		return agent.BoundEmployee{EmployeeID: r.EmployeeID, Name: r.Name, Status: r.Status, Packs: r.Packs}, nil
	}
}

// installRoot is C:\Program Files\OffManual (OFFMANUAL_INSTALL_ROOT overrides for development).
func installRoot() string {
	if v := os.Getenv("OFFMANUAL_INSTALL_ROOT"); v != "" {
		return v
	}
	pf := os.Getenv("ProgramFiles")
	if pf == "" {
		pf = `C:\Program Files`
	}
	return filepath.Join(pf, "OffManual")
}

// InstallRoot is C:\Program Files\OffManual (or OFFMANUAL_INSTALL_ROOT).
func InstallRoot() string { return installRoot() }

// ServiceBinaryPath maps an executable inside <root>\versions\<v>\ to
// <root>\current\<name>, so the service follows `current` (ADR-062). Other paths are
// returned unchanged (developer builds).
func ServiceBinaryPath(exe string) string {
	return serviceBinaryPath(installRoot(), exe)
}

func serviceBinaryPath(root, exe string) string {
	rel, err := filepath.Rel(filepath.Join(root, "versions"), exe)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return exe
	}
	parts := strings.SplitN(filepath.ToSlash(rel), "/", 2)
	if len(parts) != 2 || parts[1] == "" {
		return exe
	}
	return filepath.Join(root, "current", filepath.FromSlash(parts[1]))
}

// EnrolledAs returns the console server ID this data directory is enrolled as ("" if none).
func EnrolledAs(ctx context.Context, dataDir string) string {
	if dataDir == "" {
		dataDir = DefaultDataDir()
	}
	p := filepath.Join(dataDir, "agent.db")
	if _, err := os.Stat(p); err != nil {
		return ""
	}
	st, err := store.Open(ctx, p)
	if err != nil {
		return ""
	}
	defer func() { _ = st.Close() }()
	id, _ := st.Meta(ctx, console.MetaServerID)
	return id
}
