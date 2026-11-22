//go:build !windows

package offboard

// ProfilePath has no meaning off Windows (the Server Agent ships only on Windows).
func ProfilePath(string) (string, error) {
	return "", ErrNoProfile
}
