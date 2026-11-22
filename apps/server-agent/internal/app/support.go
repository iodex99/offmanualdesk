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
		report := boundReport(preflight.Run(ctx, preflight.Standard(preflight.DefaultOptions())), supportLimits)
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

// reportLimits are the console's size limits for a pre-flight report.
type reportLimits struct{ results, id, title, detail, fix int }

var (
	// supportLimits match lib/support.ts (ADR-050).
	supportLimits = reportLimits{results: 50, id: 200, title: 200, detail: 500, fix: 500}
	// enrolLimits match the enrolment schema in lib/agent-api.ts.
	enrolLimits = reportLimits{results: 40, id: 32, title: 80, detail: 200, fix: 300}
)

// boundReport keeps a report within the console's limits so a long message can never
// make the console refuse the whole request.
func boundReport(r preflight.Report, l reportLimits) preflight.Report {
	if len(r.Results) > l.results {
		r.Results = r.Results[:l.results]
	}
	out := make([]preflight.Result, len(r.Results))
	for i, x := range r.Results {
		out[i] = preflight.Result{ID: cut(x.ID, l.id), Title: cut(x.Title, l.title), Status: x.Status,
			Detail: cut(x.Detail, l.detail), Fix: cut(x.Fix, l.fix)}
	}
	r.Results = out
	return r
}
