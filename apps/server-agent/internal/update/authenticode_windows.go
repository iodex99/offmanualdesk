//go:build windows

package update

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// VerifyAuthenticode checks a file's embedded Authenticode signature with
// WinVerifyTrust (WINTRUST_ACTION_GENERIC_VERIFY_V2): the signature must be valid,
// chain to a trusted root and match the file's bytes (ADR-055). Pattern from
// golang.org/x/sys/windows TestWinVerifyTrust (v0.50.0): verify, then close.
// Revocation is checked for the whole chain.
func VerifyAuthenticode(path string) error {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	data := &windows.WinTrustData{
		Size:             uint32(unsafe.Sizeof(windows.WinTrustData{})),
		UIChoice:         windows.WTD_UI_NONE,
		RevocationChecks: windows.WTD_REVOKE_WHOLECHAIN,
		UnionChoice:      windows.WTD_CHOICE_FILE,
		StateAction:      windows.WTD_STATEACTION_VERIFY,
		// G103: WinTrustData takes a pointer to WinTrustFileInfo; the struct outlives both calls.
		FileOrCatalogOrBlobOrSgnrOrCert: unsafe.Pointer(&windows.WinTrustFileInfo{ //nolint:gosec // audited above
			Size:     uint32(unsafe.Sizeof(windows.WinTrustFileInfo{})),
			FilePath: p,
		}),
	}
	verifyErr := windows.WinVerifyTrustEx(windows.InvalidHWND, &windows.WINTRUST_ACTION_GENERIC_VERIFY_V2, data)
	data.StateAction = windows.WTD_STATEACTION_CLOSE
	_ = windows.WinVerifyTrustEx(windows.InvalidHWND, &windows.WINTRUST_ACTION_GENERIC_VERIFY_V2, data)
	if verifyErr != nil {
		return fmt.Errorf("%w: %w", ErrUntrustedBinary, verifyErr)
	}
	return nil
}
