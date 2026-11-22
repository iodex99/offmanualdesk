// Package preflight checks that a firm's server is ready for Off Manual Desk
// (docs/ARCHITECTURE.md F1 step 4). Results go to the console's setup wizard, so
// they hold no client data: no share paths, no file names, just pass/warn/fail and
// a plain-language fix.
package preflight

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Status of one check.
type Status string

// Statuses, worst last.
const (
	Pass Status = "pass"
	Skip Status = "skip"
	Warn Status = "warn"
	Fail Status = "fail"
)

// Result is one check's outcome.
type Result struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status Status `json:"status"`
	Detail string `json:"detail"`
	Fix    string `json:"fix,omitempty"`
}

// Check is a named probe.
type Check struct {
	ID, Title string
	Run       func(ctx context.Context) (Status, string, string) // status, detail, fix
}

// Report is the whole run.
type Report struct {
	At      time.Time `json:"at"`
	Overall Status    `json:"overall"`
	Results []Result  `json:"results"`
}

// Options configure the standard checks.
type Options struct {
	InstallDir    string   // contains current\node\node.exe
	Share         string   // UNC root of the Clients share (checked, never reported)
	URLs          []string // outbound HTTPS endpoints (console, LLM provider, Telegram)
	MinRAMGB      float64
	MinFreeDiskGB float64
}

// DefaultOptions fit a 10–30 seat firm (ADR-001 sizing to be confirmed by lab L1).
func DefaultOptions() Options {
	return Options{
		InstallDir:    `C:\Program Files\OffManual`,
		URLs:          []string{"https://api.anthropic.com", "https://api.telegram.org"},
		MinRAMGB:      16,
		MinFreeDiskGB: 20,
	}
}

// Run executes checks in order, each with its own timeout and panic guard.
func Run(ctx context.Context, checks []Check) Report {
	r := Report{At: time.Now().UTC(), Overall: Pass}
	rank := map[Status]int{Pass: 0, Skip: 0, Warn: 1, Fail: 2}
	for _, c := range checks {
		res := runOne(ctx, c)
		r.Results = append(r.Results, res)
		if rank[res.Status] > rank[r.Overall] {
			r.Overall = res.Status
		}
	}
	return r
}

func runOne(ctx context.Context, c Check) (res Result) {
	res = Result{ID: c.ID, Title: c.Title}
	defer func() {
		if p := recover(); p != nil {
			res.Status, res.Detail, res.Fix = Fail, "The check itself failed.", "Send this report to Off Manual."
		}
	}()
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	res.Status, res.Detail, res.Fix = c.Run(cctx)
	return res
}

// ---- portable checks ----

// ShareCheck confirms the Clients share is reachable by the account running the check.
func ShareCheck(share string) Check {
	return Check{ID: "file_share", Title: "Clients file share", Run: func(context.Context) (Status, string, string) {
		if share == "" {
			return Skip, "No file share was given.", "Re-run with -share \\\\server\\Clients."
		}
		if !strings.HasPrefix(share, `\\`) {
			return Warn, "The share is not a UNC path.", `Use the \\server\share form; mapped drives are not visible to the assistant.`
		}
		st, err := os.Stat(share)
		if err != nil || !st.IsDir() {
			return Fail, "The Clients share could not be opened from this server.", "Check the file server is on and this server can reach it."
		}
		return Pass, "The Clients share is reachable.", ""
	}}
}

var nodeVersionRe = regexp.MustCompile(`^v(\d+)\.(\d+)\.(\d+)`)

// NodeSupported applies OpenClaw 2026.11.6's engines rule: >=24.16.0 <25 || >=26.1.0
// (docs/OPENCLAW_NOTES.md §2).
func NodeSupported(v string) bool {
	m := nodeVersionRe.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		return false
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	switch major {
	case 24:
		return minor >= 16
	case 26:
		return minor >= 1
	default:
		return major > 26
	}
}

// NodeCheck runs the bundled Node and checks its version.
func NodeCheck(nodeExe string) Check {
	return Check{ID: "node_runtime", Title: "Bundled Node runtime", Run: func(ctx context.Context) (Status, string, string) {
		if _, err := os.Stat(nodeExe); err != nil {
			return Fail, "The bundled Node runtime is missing.", "Reinstall Off Manual Desk."
		}
		out, err := exec.CommandContext(ctx, nodeExe, "--version").Output()
		if err != nil {
			return Fail, "The bundled Node runtime did not start.", "Check antivirus logs for blocked files under Program Files\\OffManual."
		}
		v := strings.TrimSpace(string(out))
		if !NodeSupported(v) {
			return Fail, "Node " + v + " is too old for the assistant.", "Install the latest Off Manual release."
		}
		return Pass, "Node " + v + " runs.", ""
	}}
}

// HTTPSCheck confirms outbound HTTPS to url and measures clock skew from the
// server's Date header.
func HTTPSCheck(id, title, url string, client *http.Client) Check {
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	return Check{ID: id, Title: title, Run: func(ctx context.Context) (Status, string, string) {
		req, err := http.NewRequestWithContext(ctx, http.MethodHead, url, nil)
		if err != nil {
			return Fail, "The address is not valid.", "Send this report to Off Manual."
		}
		resp, err := client.Do(req)
		if err != nil {
			return Fail, "This server can't reach " + hostOf(url) + " over HTTPS.", "Allow outbound HTTPS (port 443) to " + hostOf(url) + " in the firewall or proxy."
		}
		_ = resp.Body.Close()
		if d, err := http.ParseTime(resp.Header.Get("Date")); err == nil {
			skew := time.Since(d)
			if skew < 0 {
				skew = -skew
			}
			if skew > 2*time.Minute {
				return Warn, fmt.Sprintf("Reachable, but this server's clock is %d minutes off.", int(skew.Minutes())),
					"Turn on Windows time sync (w32tm /resync). Authenticator codes fail when the clock is wrong."
			}
		}
		return Pass, hostOf(url) + " is reachable.", ""
	}}
}

func hostOf(u string) string {
	u = strings.TrimPrefix(strings.TrimPrefix(u, "https://"), "http://")
	if i := strings.IndexAny(u, "/:"); i >= 0 {
		u = u[:i]
	}
	return u
}

// Standard returns the full check list for this platform.
func Standard(o Options) []Check {
	checks := platformChecks(o)
	checks = append(checks, NodeCheck(o.InstallDir+`\current\node\node.exe`), ShareCheck(o.Share))
	for i, u := range o.URLs {
		checks = append(checks, HTTPSCheck(fmt.Sprintf("https_%d", i+1), "Internet access to "+hostOf(u), u, nil))
	}
	return checks
}
