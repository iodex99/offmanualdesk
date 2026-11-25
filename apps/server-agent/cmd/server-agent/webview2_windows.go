//go:build windows

package main

import (
	"context"
	"fmt"
	"os/exec"
	"time"

	"offmanual/desk/server-agent/internal/update"
)

// installWebView2 runs Microsoft's Evergreen Standalone Installer per-machine
// ("<installer> /silent /install" from an elevated process; Microsoft Learn,
// "Distribute your app and the WebView2 Runtime"). Its Authenticode signature is
// checked first; success is confirmed by the registry check afterwards (no documented
// exit codes).
func installWebView2(installer string) error {
	if err := update.VerifyAuthenticode(installer); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	out, err := exec.CommandContext(ctx, installer, "/silent", "/install").CombinedOutput() //nolint:gosec // our own signed redist path
	if err != nil {
		return fmt.Errorf("%w: %s", err, string(out))
	}
	return nil
}
