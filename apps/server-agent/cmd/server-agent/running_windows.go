//go:build windows

package main

import (
	"context"
	"errors"
	"io/fs"
	"time"

	"offmanual/desk/server-agent/internal/pipe"
)

// agentRunning reports whether the Server Agent's pipe exists. Only "not found" counts
// as stopped; busy, refused or slow means it is running (restore must not proceed).
func agentRunning() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, err := pipe.Dial(ctx, pipe.Name)
	if err == nil {
		_ = conn.Close()
		return true
	}
	return !errors.Is(err, fs.ErrNotExist)
}
