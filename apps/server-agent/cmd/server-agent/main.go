// Command server-agent is the Off Manual Server Agent: a Windows service (LocalSystem)
// on the firm's RDS host. See docs/ARCHITECTURE.md §1 and §3.
//
// M0: only `version` and `help` are implemented. Service install/run arrives in M2.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"offmanual/desk/server-agent/internal/version"
)

const usage = `Off Manual Server Agent

Usage:
  server-agent version     Print build information as JSON
  server-agent help        Show this help

Coming in M2: install, uninstall, run, enroll <code>, preflight.
`

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run executes a subcommand and returns the process exit code.
func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		_, _ = fmt.Fprint(stderr, usage)
		return 2
	}
	switch args[0] {
	case "version", "--version", "-v":
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(version.Get()); err != nil {
			_, _ = fmt.Fprintf(stderr, "could not print version: %v\n", err)
			return 1
		}
		return 0
	case "help", "--help", "-h":
		_, _ = fmt.Fprint(stdout, usage)
		return 0
	default:
		_, _ = fmt.Fprintf(stderr, "unknown command %q\n\n%s", args[0], usage)
		return 2
	}
}
