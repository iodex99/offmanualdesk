// Command server-agent is the Off Manual Server Agent: a Windows service (LocalSystem)
// on the firm's RDS host. See docs/ARCHITECTURE.md §1 and §3.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"

	"offmanual/desk/server-agent/internal/app"
	"offmanual/desk/server-agent/internal/version"
)

// ServiceName is the Windows service name.
const ServiceName = "OffManualAgent"

const usage = `Off Manual Server Agent

Usage:
  server-agent version              Print build information as JSON
  server-agent run [-data DIR]      Run in the foreground (development, diagnostics)
  server-agent install [-data DIR]  Install and start the Windows service (run as Administrator)
  server-agent uninstall            Stop and remove the Windows service (run as Administrator)
  server-agent help                 Show this help

Coming next: enroll <code>, preflight.
`

func main() {
	if isService() {
		if err := runService(); err != nil {
			os.Exit(1)
		}
		return
	}
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
	case "run":
		fs := flag.NewFlagSet("run", flag.ContinueOnError)
		fs.SetOutput(stderr)
		data := fs.String("data", "", "data directory (default %ProgramData%\\OffManual)")
		if err := fs.Parse(args[1:]); err != nil {
			return 2
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
		defer stop()
		if err := app.Run(ctx, app.Options{DataDir: *data, LogWriter: stderr}); err != nil {
			_, _ = fmt.Fprintf(stderr, "server-agent: %v\n", err)
			return 1
		}
		return 0
	case "install":
		fs := flag.NewFlagSet("install", flag.ContinueOnError)
		fs.SetOutput(stderr)
		data := fs.String("data", "", "data directory (default %ProgramData%\\OffManual)")
		if err := fs.Parse(args[1:]); err != nil {
			return 2
		}
		if err := installService(*data); err != nil {
			_, _ = fmt.Fprintf(stderr, "install failed: %v\n", err)
			return 1
		}
		_, _ = fmt.Fprintf(stdout, "Installed and started %s.\n", ServiceName)
		return 0
	case "uninstall":
		if err := uninstallService(); err != nil {
			_, _ = fmt.Fprintf(stderr, "uninstall failed: %v\n", err)
			return 1
		}
		_, _ = fmt.Fprintf(stdout, "Removed %s. Data in the data directory was kept.\n", ServiceName)
		return 0
	default:
		_, _ = fmt.Fprintf(stderr, "unknown command %q\n\n%s", args[0], usage)
		return 2
	}
}
