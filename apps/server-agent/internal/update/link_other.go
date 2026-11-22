//go:build !windows

package update

import "os"

// makeDirLink uses a symbolic link off Windows (tests only; the agent ships on Windows).
func makeDirLink(link, target string) error {
	return os.Symlink(target, link)
}
