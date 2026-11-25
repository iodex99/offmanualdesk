//go:build !windows

package main

import "offmanual/desk/server-agent/internal/app"

func installWebView2(string) error { return app.ErrUnsupported }
