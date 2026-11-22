//go:build windows

package secrets

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// DPAPI is the production Protector (machine scope, no UI).
type DPAPI struct{}

func blob(b []byte) *windows.DataBlob {
	if len(b) == 0 {
		return &windows.DataBlob{}
	}
	return &windows.DataBlob{Size: uint32(len(b)), Data: &b[0]} //nolint:gosec // secrets are small
}

func takeBlob(out *windows.DataBlob) []byte {
	// DPAPI allocates the output with LocalAlloc; copy it into Go memory, then free it.
	defer func() { _, _ = windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data))) }() //nolint:gosec // G103: required by the DPAPI ABI
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...)                       //nolint:gosec // G103: bounded by out.Size
}

// Protect encrypts plain with CryptProtectData (Microsoft Learn: CryptProtectData).
func (DPAPI) Protect(plain []byte) ([]byte, error) {
	if len(plain) == 0 {
		return nil, ErrEmpty
	}
	var out windows.DataBlob
	if err := windows.CryptProtectData(blob(plain), nil, blob(entropy), 0, nil,
		windows.CRYPTPROTECT_LOCAL_MACHINE|windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, fmt.Errorf("CryptProtectData: %w", err)
	}
	return takeBlob(&out), nil
}

// Unprotect decrypts a blob made by Protect.
func (DPAPI) Unprotect(b []byte) ([]byte, error) {
	if len(b) == 0 {
		return nil, ErrUnprotect
	}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(blob(b), nil, blob(entropy), 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, ErrUnprotect
	}
	return takeBlob(&out), nil
}

// Default returns the platform Protector.
func Default() Protector { return DPAPI{} }
