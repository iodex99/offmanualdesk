//go:build !windows

package app

import (
	"os"
	"path/filepath"
)

// DefaultDataDir is a development location on non-Windows hosts.
func DefaultDataDir() string { return filepath.Join(os.TempDir(), "offmanual-dev") }

// PrepareDataDir creates the directory tree.
func PrepareDataDir(dir string) error {
	for _, d := range []string{dir, filepath.Join(dir, "logs")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	return nil
}
