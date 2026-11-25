//go:build !windows

package main

import "offmanual/desk/server-agent/internal/app"

func isService() bool             { return false }
func runService() error           { return app.ErrUnsupported }
func installService(string) error { return app.ErrUnsupported }
func uninstallService() error     { return app.ErrUnsupported }
func serviceInstalled() bool      { return false }
