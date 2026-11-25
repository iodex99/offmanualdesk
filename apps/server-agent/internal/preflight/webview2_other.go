//go:build !windows

package preflight

// WebView2Version: WebView2 only exists on Windows.
func WebView2Version() string { return "" }
