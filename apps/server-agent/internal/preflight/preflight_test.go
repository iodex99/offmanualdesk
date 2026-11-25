package preflight

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestRunAggregatesWorstStatusAndRecoversPanics(t *testing.T) {
	checks := []Check{
		{ID: "a", Title: "A", Run: func(context.Context) (Status, string, string) { return Pass, "ok", "" }},
		{ID: "b", Title: "B", Run: func(context.Context) (Status, string, string) { return Warn, "meh", "fix b" }},
		{ID: "c", Title: "C", Run: func(context.Context) (Status, string, string) { panic("boom") }},
	}
	r := Run(context.Background(), checks)
	if r.Overall != Fail || len(r.Results) != 3 || r.Results[2].Status != Fail {
		t.Fatalf("report %+v", r)
	}
	if _, err := json.Marshal(r); err != nil {
		t.Fatal(err)
	}
	if Run(context.Background(), checks[:1]).Overall != Pass {
		t.Fatal("all-pass report not pass")
	}
}

func TestNodeSupported(t *testing.T) {
	for v, want := range map[string]bool{
		"v24.22.3": true, "v24.16.0": true, "v24.15.9": false, "v25.1.0": false, "v26.0.0": false,
		"v26.1.0": true, "v27.0.0": true, "v22.18.0": false, "garbage": false, "": false,
	} {
		if got := NodeSupported(v); got != want {
			t.Errorf("NodeSupported(%q) = %v, want %v", v, got, want)
		}
	}
}

func TestShareCheck(t *testing.T) {
	if st, _, _ := ShareCheck("").Run(context.Background()); st != Skip {
		t.Fatalf("empty share: %s", st)
	}
	if st, _, _ := ShareCheck(t.TempDir()).Run(context.Background()); st != Warn {
		t.Fatalf("non-UNC: %s", st)
	}
	if st, detail, _ := ShareCheck(`\\no-such-host-om-test\Clients`).Run(context.Background()); st != Fail || strings.Contains(detail, "no-such-host") {
		t.Fatalf("unreachable share: %s %q (detail must not echo the path)", st, detail)
	}
}

func TestHTTPSCheckReachabilityAndClockSkew(t *testing.T) {
	ok := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Date", time.Now().UTC().Format(http.TimeFormat))
	}))
	defer ok.Close()
	if st, _, _ := HTTPSCheck("x", "X", ok.URL, ok.Client()).Run(context.Background()); st != Pass {
		t.Fatalf("reachable: %s", st)
	}
	skewed := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Date", time.Now().Add(-10*time.Minute).UTC().Format(http.TimeFormat))
	}))
	defer skewed.Close()
	st, detail, fix := HTTPSCheck("x", "X", skewed.URL, skewed.Client()).Run(context.Background())
	if st != Warn || !strings.Contains(detail, "clock") || !strings.Contains(fix, "w32tm") {
		t.Fatalf("skew: %s %q %q", st, detail, fix)
	}
	dead := httptest.NewTLSServer(http.NotFoundHandler())
	url := dead.URL
	dead.Close()
	if st, _, fix := HTTPSCheck("x", "X", url, nil).Run(context.Background()); st != Fail || !strings.Contains(fix, "443") {
		t.Fatalf("dead: %s %q", st, fix)
	}
}

func TestNodeCheckMissing(t *testing.T) {
	if st, _, _ := NodeCheck(`Z:\nope\node.exe`).Run(context.Background()); st != Fail {
		t.Fatalf("missing node: %s", st)
	}
}

func TestStandardRunsOnThisMachine(t *testing.T) {
	o := DefaultOptions()
	o.URLs = nil
	o.InstallDir = os.TempDir()
	r := Run(context.Background(), Standard(o))
	if len(r.Results) < 2 {
		t.Fatalf("too few checks: %+v", r.Results)
	}
	for _, res := range r.Results {
		if res.Status == "" || res.Detail == "" {
			t.Errorf("check %s returned an empty result", res.ID)
		}
		if res.Status == Fail && res.Fix == "" {
			t.Errorf("check %s failed without a fix", res.ID)
		}
	}
	t.Logf("overall %s", r.Overall)
	for _, res := range r.Results {
		t.Logf("%-16s %-4s %s", res.ID, res.Status, res.Detail)
	}
}

func TestPythonCheck(t *testing.T) {
	if st, _, fix := PythonCheck(`Z:\nope\python.exe`).Run(context.Background()); st != Fail || fix == "" {
		t.Fatalf("missing python: %s", st)
	}
	// A real bundle (tools/release/bundle_python.py) when one is available.
	exe := os.Getenv("OFFMANUAL_TEST_PYTHON")
	if exe == "" {
		t.Skip("set OFFMANUAL_TEST_PYTHON to a bundled python.exe to run it")
	}
	st, detail, _ := PythonCheck(exe).Run(context.Background())
	if st != Pass || !strings.Contains(detail, "Excel libraries") {
		t.Fatalf("%s %s", st, detail)
	}
	t.Log(detail)
}
