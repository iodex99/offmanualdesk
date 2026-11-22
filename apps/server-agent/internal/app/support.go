package app

import (
	"bufio"
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"
	"unicode/utf8"

	"offmanual/desk/server-agent/internal/agent"
	"offmanual/desk/server-agent/internal/console"
	"offmanual/desk/server-agent/internal/preflight"
	"offmanual/desk/server-agent/internal/version"
)

// LogTailLines is how many of the Server Agent's own log lines go into a support bundle.
const LogTailLines = 200

// tailLines returns the last n lines of a file (each cut at 1000 characters).
func tailLines(path string, n int) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	ring := make([]string, 0, n)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if len(line) > 1000 {
			line = line[:1000]
		}
		if len(ring) == n {
			ring = ring[1:]
		}
		ring = append(ring, line)
	}
	return ring, sc.Err()
}

// supportSource builds the server part of a bundle (ADR-050): version, pre-flight
// (bounded to 20 s) and the log tail. The log is metadata only by construction
// (SECURITY: no client content in logs).
func supportSource(dataDir string) agent.SupportSource {
	return func(ctx context.Context) (map[string]any, error) {
		ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		report := boundReport(preflight.Run(ctx, preflight.Standard(preflight.DefaultOptions())))
		lines, err := tailLines(filepath.Join(dataDir, "logs", "server-agent.log"), LogTailLines)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			lines = []string{"(log unreadable)"}
		}
		if lines == nil {
			lines = []string{} // the console expects an array, never null
		}
		return map[string]any{
			"agentVersion": version.Get().Version,
			"preflight":    report,
			"logTail":      lines,
		}, nil
	}
}

// supportUploader sends the bundle to the console.
func supportUploader(c *console.Client) agent.SupportSubmitter {
	return func(ctx context.Context, employeeID, description string, bundle map[string]any) (string, error) {
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		ref, err := c.SubmitSupport(ctx, employeeID, description, bundle)
		var api *console.APIError
		if errors.As(err, &api) && api.Status >= 400 && api.Status < 500 && api.Status != 401 && api.Message != "" {
			return "", agent.UserMessage(api.Message)
		}
		return ref, err
	}
}

// cut shortens s to at most n bytes without splitting a UTF-8 character.
func cut(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// boundReport keeps the report within the console's limits (ADR-050: ids/titles 200,
// details 500, at most 50 results).
func boundReport(r preflight.Report) preflight.Report {
	if len(r.Results) > 50 {
		r.Results = r.Results[:50]
	}
	out := make([]preflight.Result, len(r.Results))
	for i, x := range r.Results {
		out[i] = preflight.Result{ID: cut(x.ID, 200), Title: cut(x.Title, 200), Status: x.Status,
			Detail: cut(x.Detail, 500), Fix: cut(x.Fix, 500)}
	}
	r.Results = out
	return r
}
