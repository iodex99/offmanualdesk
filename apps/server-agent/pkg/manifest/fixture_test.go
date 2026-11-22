package manifest

import (
	"os"
	"path/filepath"
	"testing"
)

// The same golden fixture is validated by the JSON Schema in
// packages/shared-schema (TypeScript side). If either side changes its idea of a
// valid manifest, one of the two tests fails.
func TestSharedFixtureParses(t *testing.T) {
	p := filepath.Join("..", "..", "..", "..", "packages", "shared-schema", "fixtures", "manifest.valid.json")
	body, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	m, err := Parse(body)
	if err != nil {
		t.Fatalf("shared fixture rejected by Go: %v", err)
	}
	if m.Severity != SeveritySecurity || m.DeadlineAt == nil || len(m.Files) != 2 {
		t.Fatalf("unexpected fixture content: %+v", m)
	}
}
