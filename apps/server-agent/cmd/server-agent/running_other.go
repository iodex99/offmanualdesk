//go:build !windows

package main

// agentRunning: there is no service off Windows.
func agentRunning() bool { return false }
