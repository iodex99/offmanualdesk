package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"offmanual/desk/server-agent/internal/preflight"
)

func TestTailLines(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.log")
	var b strings.Builder
	for i := 1; i <= 250; i++ {
		b.WriteString("line " + strconv.Itoa(i) + "\n")
	}
	b.WriteString(strings.Repeat("y", 1500) + "\n")
	if err := os.WriteFile(p, []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	lines, err := tailLines(p, LogTailLines)
	if err != nil || len(lines) != LogTailLines || lines[0] != "line 52" || len(lines[len(lines)-1]) != 1000 {
		t.Fatalf("tail: %d lines, first %q, err %v", len(lines), lines[0], err)
	}
	if _, err := tailLines(filepath.Join(t.TempDir(), "missing.log"), 5); !os.IsNotExist(err) {
		t.Fatalf("missing file: %v", err)
	}
}

func TestSupportSourceShapeMatchesTheConsole(t *testing.T) {
	dir := t.TempDir() // no log file yet
	m, err := supportSource(dir)(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(m)
	var back map[string]any
	_ = json.Unmarshal(b, &back)
	if tail, ok := back["logTail"].([]any); !ok || len(tail) != 0 {
		t.Fatalf("logTail must be an empty array, got %v", back["logTail"])
	}
	pf, ok := back["preflight"].(map[string]any)
	if !ok || pf["overall"] == nil || pf["results"] == nil {
		t.Fatalf("preflight %v", back["preflight"])
	}
	for _, r := range pf["results"].([]any) {
		res := r.(map[string]any)
		if len(res["detail"].(string)) > 500 || len(res["title"].(string)) > 200 {
			t.Fatalf("unbounded result %v", res)
		}
	}
	long := boundReport(preflight.Report{Results: []preflight.Result{{ID: "x", Title: "t", Status: preflight.Warn, Detail: strings.Repeat("d", 900)}}})
	if len(long.Results[0].Detail) != 500 {
		t.Fatal("detail not cut")
	}
}

func TestCutKeepsCharactersWhole(t *testing.T) {
	if got := cut("₹₹₹", 4); got != "₹" { // ₹ is 3 bytes
		t.Fatalf("cut %q", got)
	}
	if cut("abc", 5) != "abc" {
		t.Fatal("short strings unchanged")
	}
}
