//go:build windows

package preflight

import "golang.org/x/sys/windows/registry"

// WebView2Version returns the per-machine Evergreen WebView2 Runtime version, or "" when
// it isn't installed. Microsoft Learn "Distribute your app and the WebView2 Runtime":
// client GUID {F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}, value "pv"; missing, empty or
// 0.0.0.0 means not installed.
func WebView2Version() string {
	for _, path := range []string{
		`SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`,
		`SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`,
	} {
		k, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		pv, _, err := k.GetStringValue("pv")
		_ = k.Close()
		if err == nil && pv != "" && pv != "0.0.0.0" {
			return pv
		}
	}
	return ""
}
