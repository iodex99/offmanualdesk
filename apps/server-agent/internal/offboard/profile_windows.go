//go:build windows

package offboard

import (
	"errors"

	"golang.org/x/sys/windows/registry"
)

// ProfilePath reads a user's profile folder from
// HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\<SID>\ProfileImagePath
// (REG_EXPAND_SZ, expanded here). Only LocalSystem/Administrators need this; it works
// whether or not the user is signed in. The SID must already be validated.
func ProfilePath(sid string) (string, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\`+sid, registry.QUERY_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return "", ErrNoProfile
	}
	if err != nil {
		return "", err
	}
	defer func() { _ = k.Close() }()
	v, typ, err := k.GetStringValue("ProfileImagePath")
	if errors.Is(err, registry.ErrNotExist) {
		return "", ErrNoProfile
	}
	if err != nil {
		return "", err
	}
	if typ == registry.EXPAND_SZ {
		return registry.ExpandString(v)
	}
	return v, nil
}
