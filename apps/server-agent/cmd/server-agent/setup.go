package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"offmanual/desk/server-agent/internal/app"
	"offmanual/desk/server-agent/internal/preflight"
	"offmanual/desk/server-agent/internal/update"
	"offmanual/desk/server-agent/pkg/manifest"
)

// First install and uninstall steps the MSI runs (ADR-071). The MSI lays down the
// release under <root>\versions\<v>\ and runs this executable from there:
//   setup    → `current` junction → versions\<v>, optional console enrolment, service
//              registered through `current` and started.
//   teardown → service stopped and removed, `current` removed, other staged versions
//              removed (the MSI removes its own files afterwards). Data in
//              %ProgramData%\OffManual (agent.db, backups, archives) is kept.

type setupDeps struct {
	exe              string
	switchCurrent    func(root, version string) error
	enrolledAs       func(ctx context.Context, dataDir string) string
	enrol            func(ctx context.Context, dataDir, consoleURL, code string, out io.Writer) error
	serviceInstalled func() bool
	install          func(dataDir string) error
	uninstall        func() error
	// WebView2 (Desk's web engine) is installed by setup when missing (ADR-072).
	webView2Version func() string
	installWebView2 func(installer string) error
}

// WebView2Installer is the Evergreen Standalone Installer the MSI places in <root>\redist.
const WebView2Installer = "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"

// layoutFromExe expects <root>\versions\<version>\server-agent.exe.
func layoutFromExe(exe string) (root, version string, err error) {
	dir := filepath.Dir(exe)
	version = filepath.Base(dir)
	versions := filepath.Dir(dir)
	if !strings.EqualFold(filepath.Base(versions), "versions") {
		return "", "", fmt.Errorf("run setup from <install root>\\versions\\<version>\\ (it was run from %s)", dir)
	}
	if _, err := manifest.CompareVersions(version, version); err != nil {
		return "", "", fmt.Errorf("%q is not a release version folder", version)
	}
	return filepath.Dir(versions), version, nil
}

func runSetup(ctx context.Context, d setupDeps, dataDir, consoleURL, code string, out io.Writer) error {
	root, version, err := layoutFromExe(d.exe)
	if err != nil {
		return err
	}
	if err := d.switchCurrent(root, version); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(out, "current → versions\\%s\n", version)
	if err := ensureWebView2(d, root, out); err != nil {
		return err
	}
	switch {
	case code == "":
		_, _ = fmt.Fprintln(out, "No enrolment code given; enrol later with: server-agent enroll -console URL CODE")
	case consoleURL == "":
		return errors.New("an enrolment code needs the console address (CONSOLEURL)")
	default:
		if id := d.enrolledAs(ctx, dataDir); id != "" {
			_, _ = fmt.Fprintf(out, "Already enrolled as %s; the code was not used.\n", id)
		} else if err := d.enrol(ctx, dataDir, consoleURL, code, out); err != nil {
			return fmt.Errorf("enrolment failed: %w", err)
		}
	}
	if d.serviceInstalled() {
		_, _ = fmt.Fprintf(out, "%s is already installed.\n", ServiceName)
		return nil
	}
	if err := d.install(dataDir); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(out, "Installed and started %s.\n", ServiceName)
	return nil
}

func runTeardown(d setupDeps, out io.Writer) error {
	root, version, err := layoutFromExe(d.exe)
	if err != nil {
		return err
	}
	var errs []error
	if d.serviceInstalled() {
		if err := d.uninstall(); err != nil {
			errs = append(errs, err)
		} else {
			_, _ = fmt.Fprintf(out, "Removed %s.\n", ServiceName)
		}
	}
	link := filepath.Join(root, "current")
	if fi, err := os.Lstat(link); err == nil && isLink(fi) {
		// A junction/symlink: Remove deletes the link, never its target.
		if err := os.Remove(link); err != nil {
			errs = append(errs, err)
		}
	}
	// Releases staged by the Server Agent after install (ADR-062); the MSI removes its own.
	ents, err := os.ReadDir(filepath.Join(root, "versions"))
	if err == nil {
		for _, e := range ents {
			if e.Name() == version || !e.IsDir() {
				continue
			}
			if _, verr := manifest.CompareVersions(e.Name(), e.Name()); verr != nil {
				continue // not ours
			}
			if err := os.RemoveAll(filepath.Join(root, "versions", e.Name())); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

func isLink(fi fs.FileInfo) bool {
	return fi.Mode()&(fs.ModeSymlink|fs.ModeIrregular) != 0
}

func realSetupDeps() (setupDeps, error) {
	exe, err := os.Executable()
	if err != nil {
		return setupDeps{}, err
	}
	return setupDeps{
		exe:              exe,
		switchCurrent:    update.SwitchCurrent,
		enrolledAs:       app.EnrolledAs,
		enrol:            app.Enrol,
		serviceInstalled: serviceInstalled,
		install:          installService,
		uninstall:        uninstallService,
		webView2Version:  preflight.WebView2Version,
		installWebView2:  installWebView2,
	}, nil
}

// ensureWebView2 installs the bundled WebView2 runtime when the server doesn't have it.
func ensureWebView2(d setupDeps, root string, out io.Writer) error {
	if v := d.webView2Version(); v != "" {
		_, _ = fmt.Fprintf(out, "WebView2 %s is installed.\n", v)
		return nil
	}
	inst := filepath.Join(root, "redist", WebView2Installer)
	if _, err := os.Stat(inst); err != nil {
		_, _ = fmt.Fprintln(out, "WebView2 is not installed and this package doesn't include it; Desk needs it.")
		return nil
	}
	if err := d.installWebView2(inst); err != nil {
		return fmt.Errorf("installing WebView2: %w", err)
	}
	v := d.webView2Version()
	if v == "" {
		return errors.New("WebView2 still isn't installed after running its installer")
	}
	_, _ = fmt.Fprintf(out, "Installed WebView2 %s.\n", v)
	return nil
}
