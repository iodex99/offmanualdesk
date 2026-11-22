//go:build windows

package preflight

import (
	"context"
	"fmt"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// memoryStatusEx mirrors MEMORYSTATUSEX (Microsoft Learn: GlobalMemoryStatusEx).
type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

var procGlobalMemoryStatusEx = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")

func totalRAM() (uint64, error) {
	m := memoryStatusEx{Length: uint32(unsafe.Sizeof(memoryStatusEx{}))}
	r, _, err := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&m))) //nolint:gosec // G103: Win32 ABI
	if r == 0 {
		return 0, err
	}
	return m.TotalPhys, nil
}

func platformChecks(o Options) []Check {
	return []Check{
		{ID: "windows_version", Title: "Windows version", Run: func(context.Context) (Status, string, string) {
			v := windows.RtlGetVersion()
			detail := fmt.Sprintf("Windows %d.%d build %d", v.MajorVersion, v.MinorVersion, v.BuildNumber)
			if v.MajorVersion < 10 || v.BuildNumber < 17763 {
				return Fail, detail + " is too old.", "Use Windows Server 2019 or newer (2022 recommended)."
			}
			if v.ProductType == 1 { // VER_NT_WORKSTATION
				return Warn, detail + " is a desktop edition.", "For more than two users at once, use Windows Server with Remote Desktop Session Host."
			}
			return Pass, detail + ".", ""
		}},
		{ID: "memory", Title: "Memory", Run: func(context.Context) (Status, string, string) {
			total, err := totalRAM()
			if err != nil {
				return Fail, "Could not read installed memory.", "Send this report to Off Manual."
			}
			gb := float64(total) / (1 << 30)
			detail := fmt.Sprintf("%.0f GB installed.", gb)
			if gb < o.MinRAMGB {
				return Warn, detail, fmt.Sprintf("Plan for at least %.0f GB; each active employee's assistant uses memory (lab L1 sets the final number).", o.MinRAMGB)
			}
			return Pass, detail, ""
		}},
		{ID: "disk", Title: "Free disk space", Run: func(context.Context) (Status, string, string) {
			var free, total, totalFree uint64
			root, _ := windows.UTF16PtrFromString(`C:\`)
			if err := windows.GetDiskFreeSpaceEx(root, &free, &total, &totalFree); err != nil {
				return Fail, "Could not read free disk space on C:.", "Send this report to Off Manual."
			}
			gb := float64(free) / (1 << 30)
			if gb < o.MinFreeDiskGB {
				return Fail, fmt.Sprintf("Only %.0f GB free on C:.", gb), fmt.Sprintf("Free up at least %.0f GB on C: (updates keep two versions side by side).", o.MinFreeDiskGB)
			}
			return Pass, fmt.Sprintf("%.0f GB free on C:.", gb), ""
		}},
		{ID: "remote_desktop", Title: "Remote Desktop", Run: func(context.Context) (Status, string, string) {
			// [A L1] fDenyTSConnections=0 means RDP is on; the RDS Session Host role itself is
			// confirmed in the lab runbook (Get-WindowsFeature RDS-RD-Server).
			k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\Terminal Server`, registry.QUERY_VALUE)
			if err != nil {
				return Fail, "Remote Desktop settings could not be read.", "Send this report to Off Manual."
			}
			defer func() { _ = k.Close() }()
			deny, _, err := k.GetIntegerValue("fDenyTSConnections")
			if err != nil || deny != 0 {
				return Fail, "Remote Desktop connections are turned off.", "Turn on Remote Desktop and install the Remote Desktop Session Host role."
			}
			return Pass, "Remote Desktop connections are allowed.", ""
		}},
		{ID: "webview2", Title: "Microsoft Edge WebView2", Run: func(context.Context) (Status, string, string) {
			// Microsoft Learn "Distribute your app and the WebView2 Runtime": Evergreen runtime
			// client GUID {F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}, value "pv".
			for _, path := range []string{
				`SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`,
				`SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`,
			} {
				if k, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE); err == nil {
					pv, _, err := k.GetStringValue("pv")
					_ = k.Close()
					if err == nil && pv != "" && pv != "0.0.0.0" {
						return Pass, "WebView2 " + pv + " is installed.", ""
					}
				}
			}
			return Warn, "WebView2 is not installed for all users.", "The Off Manual installer adds it; or install the Evergreen WebView2 Runtime from Microsoft."
		}},
		{ID: "tally", Title: "TallyPrime", Run: func(context.Context) (Status, string, string) {
			for _, root := range []string{`SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`, `SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`} {
				k, err := registry.OpenKey(registry.LOCAL_MACHINE, root, registry.ENUMERATE_SUB_KEYS)
				if err != nil {
					continue
				}
				names, _ := k.ReadSubKeyNames(-1)
				_ = k.Close()
				for _, n := range names {
					sk, err := registry.OpenKey(registry.LOCAL_MACHINE, root+`\`+n, registry.QUERY_VALUE)
					if err != nil {
						continue
					}
					dn, _, _ := sk.GetStringValue("DisplayName")
					dv, _, _ := sk.GetStringValue("DisplayVersion")
					_ = sk.Close()
					if strings.Contains(strings.ToLower(dn), "tallyprime") {
						return Pass, strings.TrimSpace(dn+" "+dv) + " is installed.", ""
					}
				}
			}
			return Warn, "TallyPrime was not found.", "Install TallyPrime if the firm uses Tally; Tally tasks stay off until it is installed."
		}},
	}
}
