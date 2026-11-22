//go:build windows

package update

import (
	"fmt"
	"os/exec"
	"strings"
)

// makeDirLink creates a directory junction (no privilege needed, unlike a symbolic
// link). Paths are built by the caller from the install root and a validated version.
func makeDirLink(link, target string) error {
	if strings.ContainsAny(link+target, "\"\r\n&|<>^%") {
		return fmt.Errorf("unexpected character in path")
	}
	out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput() //nolint:gosec // paths checked above
	if err != nil {
		return fmt.Errorf("mklink: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
