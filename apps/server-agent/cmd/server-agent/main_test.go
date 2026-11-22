package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"offmanual/desk/server-agent/internal/version"
)

func TestRunVersionPrintsJSON(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"version"}, &out, &errOut); code != 0 {
		t.Fatalf("exit code = %d, stderr = %q", code, errOut.String())
	}
	var got version.Info
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("version output is not JSON: %v\n%s", err, out.String())
	}
	if got.Name != "offmanual-server-agent" || got.Version == "" {
		t.Fatalf("unexpected version info: %+v", got)
	}
}

func TestRunNoArgsShowsUsage(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run(nil, &out, &errOut); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(errOut.String(), "Usage:") {
		t.Fatalf("usage not printed: %q", errOut.String())
	}
}

func TestRunUnknownCommand(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"bogus"}, &out, &errOut); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(errOut.String(), `unknown command "bogus"`) {
		t.Fatalf("missing error: %q", errOut.String())
	}
}

func TestRunHelp(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"help"}, &out, &errOut); code != 0 {
		t.Fatalf("exit code = %d", code)
	}
	if !strings.Contains(out.String(), "server-agent version") {
		t.Fatalf("help text missing commands: %q", out.String())
	}
}

func TestRunRestoreNeedsAFile(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"restore"}, &out, &errOut); code != 2 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(errOut.String(), "stop the OffManualAgent service first") {
		t.Fatalf("stderr %q", errOut.String())
	}
}
