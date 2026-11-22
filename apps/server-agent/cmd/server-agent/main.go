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
	"strings"

	"offmanual/desk/server-agent/internal/app"
	"offmanual/desk/server-agent/internal/preflight"
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
  server-agent preflight [-share \\fs\Clients] [-json]  Check this server is ready
  server-agent bridge               Relay stdin/stdout to the agent pipe (for Node clients; ADR-034)
  server-agent help                 Show this help

Coming next: enroll <code>.
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
	case "bridge":
		fs := flag.NewFlagSet("bridge", flag.ContinueOnError)
		fs.SetOutput(stderr)
		name := fs.String("pipe", "", `pipe name (default \\.\pipe\offmanual-agent)`)
		server := fs.String("server-sid", "", "expected server SID (default LocalSystem S-1-5-18)")
		if err := fs.Parse(args[1:]); err != nil {
			return 2
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
		defer stop()
		if err := bridge(ctx, *name, *server, os.Stdin, stdout); err != nil {
			_, _ = fmt.Fprintf(stderr, "bridge: %v\n", err)
			return 1
		}
		return 0
	case "preflight":
		fs := flag.NewFlagSet("preflight", flag.ContinueOnError)
		fs.SetOutput(stderr)
		share := fs.String("share", "", `UNC path of the Clients share, e.g. \\fs01\Clients`)
		install := fs.String("install-dir", "", `install folder (default C:\Program Files\OffManual)`)
		asJSON := fs.Bool("json", false, "print JSON")
		if err := fs.Parse(args[1:]); err != nil {
			return 2
		}
		o := preflight.DefaultOptions()
		o.Share = *share
		if *install != "" {
			o.InstallDir = *install
		}
		r := preflight.Run(context.Background(), preflight.Standard(o))
		if *asJSON {
			enc := json.NewEncoder(stdout)
			enc.SetIndent("", "  ")
			_ = enc.Encode(r)
		} else {
			for _, res := range r.Results {
				_, _ = fmt.Fprintf(stdout, "%-5s %-28s %s\n", strings.ToUpper(string(res.Status)), res.Title, res.Detail)
				if res.Fix != "" {
					_, _ = fmt.Fprintf(stdout, "      → %s\n", res.Fix)
				}
			}
			_, _ = fmt.Fprintf(stdout, "\nOverall: %s\n", strings.ToUpper(string(r.Overall)))
		}
		if r.Overall == preflight.Fail {
			return 1
		}
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
