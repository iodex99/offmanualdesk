//go:build !windows

package update

// VerifyAuthenticode can't check Authenticode off Windows; staging a release that
// declares signed binaries therefore fails there (the Server Agent only ships on Windows).
func VerifyAuthenticode(string) error {
	return ErrUntrustedBinary
}
