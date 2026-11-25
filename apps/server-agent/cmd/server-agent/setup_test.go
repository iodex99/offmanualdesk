package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"offmanual/desk/server-agent/internal/update"
)

type fakeSvc struct {
	installed            bool
	installs, uninstalls int
	enrols               []string
	enrolledAs           string
	enrolErr             error
	webview              string // installed WebView2 version
	webviewRuns          int
	webviewAfter         string // version after the installer runs
	webviewErr           error
}

func installedTree(t *testing.T, versions ...string) (root string) {
	t.Helper()
	root = filepath.Join(t.TempDir(), "OffManual")
	for _, v := range versions {
		dir := filepath.Join(root, "versions", v)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		_ = os.WriteFile(filepath.Join(dir, "manifest.json"), []byte("{}"), 0o600)
		_ = os.WriteFile(filepath.Join(dir, "server-agent.exe"), []byte("x"), 0o600)
	}
	return root
}

func deps(root, v string, f *fakeSvc) setupDeps {
	return setupDeps{
		exe:           filepath.Join(root, "versions", v, "server-agent.exe"),
		switchCurrent: update.SwitchCurrent,
		enrolledAs:    func(context.Context, string) string { return f.enrolledAs },
		enrol: func(_ context.Context, _, url, code string, _ io.Writer) error {
			f.enrols = append(f.enrols, url+" "+code)
			return f.enrolErr
		},
		serviceInstalled: func() bool { return f.installed },
		install: func(string) error {
			f.installs++
			f.installed = true
			return nil
		},
		uninstall: func() error {
			f.uninstalls++
			f.installed = false
			return nil
		},
		webView2Version: func() string { return f.webview },
		installWebView2: func(string) error {
			f.webviewRuns++
			if f.webviewErr != nil {
				return f.webviewErr
			}
			f.webview = f.webviewAfter
			return nil
		},
	}
}

func TestSetupMakesCurrentEnrolsAndInstalls(t *testing.T) {
	root := installedTree(t, "1.0.0")
	f := &fakeSvc{}
	var out bytes.Buffer
	if err := runSetup(context.Background(), deps(root, "1.0.0", f), "", "https://console.test", "ABCD-2345", &out); err != nil {
		t.Fatal(err)
	}
	if v, _ := update.CurrentVersion(root); v != "1.0.0" {
		t.Fatalf("current %q", v)
	}
	if len(f.enrols) != 1 || f.enrols[0] != "https://console.test ABCD-2345" || f.installs != 1 {
		t.Fatalf("%+v", f)
	}
	// Running again (repair) is safe: already installed, already enrolled.
	f.enrolledAs = "srv_1"
	out.Reset()
	if err := runSetup(context.Background(), deps(root, "1.0.0", f), "", "https://console.test", "ABCD-2345", &out); err != nil {
		t.Fatal(err)
	}
	if len(f.enrols) != 1 || f.installs != 1 || !strings.Contains(out.String(), "Already enrolled as srv_1") {
		t.Fatalf("repeat setup: %+v %q", f, out.String())
	}
}

func TestSetupWithoutCodeAndRefusals(t *testing.T) {
	root := installedTree(t, "1.0.0")
	f := &fakeSvc{}
	var out bytes.Buffer
	if err := runSetup(context.Background(), deps(root, "1.0.0", f), "", "", "", &out); err != nil {
		t.Fatal(err)
	}
	if len(f.enrols) != 0 || f.installs != 1 || !strings.Contains(out.String(), "enrol later") {
		t.Fatalf("no-code setup: %+v %q", f, out.String())
	}
	if err := runSetup(context.Background(), deps(root, "1.0.0", &fakeSvc{}), "", "", "ABCD", io.Discard); err == nil {
		t.Fatal("code without a console URL accepted")
	}
	f2 := &fakeSvc{enrolErr: errors.New("code expired")}
	if err := runSetup(context.Background(), deps(root, "1.0.0", f2), "", "https://c", "X", io.Discard); err == nil || f2.installs != 0 {
		t.Fatal("failed enrolment must fail setup before the service is installed")
	}
	// Not run from versions\<v>: refused without touching anything.
	bad := deps(root, "1.0.0", &fakeSvc{})
	bad.exe = filepath.Join(root, "server-agent.exe")
	if err := runSetup(context.Background(), bad, "", "", "", io.Discard); err == nil {
		t.Fatal("setup outside versions accepted")
	}
	bad.exe = filepath.Join(root, "versions", "latest", "server-agent.exe")
	if err := runSetup(context.Background(), bad, "", "", "", io.Discard); err == nil {
		t.Fatal("non-version folder accepted")
	}
}

func TestTeardownRemovesServiceCurrentAndStagedVersions(t *testing.T) {
	root := installedTree(t, "1.0.0", "1.1.0")
	f := &fakeSvc{}
	if err := runSetup(context.Background(), deps(root, "1.0.0", f), "", "", "", io.Discard); err != nil {
		t.Fatal(err)
	}
	_ = os.MkdirAll(filepath.Join(root, "versions", "notes"), 0o755) // not a version: left alone
	if err := runTeardown(deps(root, "1.0.0", f), io.Discard); err != nil {
		t.Fatal(err)
	}
	if f.uninstalls != 1 {
		t.Fatal("service not removed")
	}
	if _, err := os.Lstat(filepath.Join(root, "current")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("current left behind")
	}
	if _, err := os.Stat(filepath.Join(root, "versions", "1.1.0")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("staged version left behind")
	}
	// The MSI's own version and unrelated folders stay for the MSI / the admin.
	for _, keep := range []string{"1.0.0", "notes"} {
		if _, err := os.Stat(filepath.Join(root, "versions", keep)); err != nil {
			t.Fatalf("%s removed", keep)
		}
	}
	// Teardown twice is harmless.
	if err := runTeardown(deps(root, "1.0.0", f), io.Discard); err != nil {
		t.Fatal(err)
	}
}

func TestSetupInstallsWebView2WhenMissing(t *testing.T) {
	ctx := context.Background()
	// Already there: the installer isn't run.
	root := installedTree(t, "1.0.0")
	f := &fakeSvc{webview: "130.0.1"}
	if err := runSetup(ctx, deps(root, "1.0.0", f), "", "", "", io.Discard); err != nil || f.webviewRuns != 0 {
		t.Fatalf("%v %+v", err, f)
	}
	// Missing and the package has no installer (test builds): setup carries on, says so.
	f2 := &fakeSvc{}
	var out bytes.Buffer
	if err := runSetup(ctx, deps(installedTree(t, "1.0.0"), "1.0.0", f2), "", "", "", &out); err != nil || f2.webviewRuns != 0 {
		t.Fatalf("%v %+v", err, f2)
	}
	if !strings.Contains(out.String(), "doesn't include it") {
		t.Fatalf("output %q", out.String())
	}
	// Missing with the bundled installer: run once, then confirmed.
	root3 := installedTree(t, "1.0.0")
	_ = os.MkdirAll(filepath.Join(root3, "redist"), 0o755)
	_ = os.WriteFile(filepath.Join(root3, "redist", WebView2Installer), []byte("x"), 0o600)
	f3 := &fakeSvc{webviewAfter: "131.0.2"}
	out.Reset()
	if err := runSetup(ctx, deps(root3, "1.0.0", f3), "", "", "", &out); err != nil || f3.webviewRuns != 1 || f3.installs != 1 {
		t.Fatalf("%v %+v", err, f3)
	}
	if !strings.Contains(out.String(), "Installed WebView2 131.0.2") {
		t.Fatalf("output %q", out.String())
	}
	// Installer fails, or runs but nothing is installed: setup fails before the service.
	f4 := &fakeSvc{webviewErr: errors.New("exit 1")}
	if err := runSetup(ctx, deps(root3, "1.0.0", f4), "", "", "", io.Discard); err == nil || f4.installs != 0 {
		t.Fatal("failed WebView2 install accepted")
	}
	f5 := &fakeSvc{}
	if err := runSetup(ctx, deps(root3, "1.0.0", f5), "", "", "", io.Discard); err == nil || f5.installs != 0 {
		t.Fatal("WebView2 still missing accepted")
	}
}
