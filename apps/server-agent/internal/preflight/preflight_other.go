//go:build !windows

package preflight

func platformChecks(Options) []Check { return nil }
