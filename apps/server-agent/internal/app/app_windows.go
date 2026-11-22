//go:build windows

package app

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"

	"offmanual/desk/server-agent/internal/pipe"
	"offmanual/desk/server-agent/internal/secrets"
)

// DataDirSDDL protects C:\ProgramData\OffManual: SYSTEM and Administrators only,
// inherited by everything inside (agent.db holds DPAPI machine-scope blobs, which any
// local user could decrypt if they could read them; lab L10, ADR-033).
const DataDirSDDL = "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"

func init() {
	listen = func(name string) (pipe.Acceptor, error) { return pipe.Listen(name) }
	protector = func() (secrets.Protector, error) { return secrets.Default(), nil }
}

// DefaultDataDir is %ProgramData%\OffManual.
func DefaultDataDir() string {
	pd, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil || pd == "" {
		pd = os.Getenv("ProgramData")
	}
	return filepath.Join(pd, "OffManual")
}

// PrepareDataDir creates the data directory tree. When running as SYSTEM (the
// service) it also applies DataDirSDDL; in a developer's foreground run the folder
// keeps the parent's permissions.
func PrepareDataDir(dir string) error {
	for _, d := range []string{dir, filepath.Join(dir, "logs"), filepath.Join(dir, "staging"), filepath.Join(dir, "backups"), filepath.Join(dir, "support")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return fmt.Errorf("create %s: %w", d, err)
		}
	}
	if !runningAsSystem() {
		return nil
	}
	return ProtectDir(dir)
}

// ProtectDir replaces dir's DACL with DataDirSDDL (protected from inheritance).
func ProtectDir(dir string) error {
	sd, err := windows.SecurityDescriptorFromString(DataDirSDDL)
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	if err := windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		return fmt.Errorf("protect %s: %w", dir, err)
	}
	return nil
}

func runningAsSystem() bool {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	return err == nil && u.User.Sid.IsWellKnown(windows.WinLocalSystemSid)
}
