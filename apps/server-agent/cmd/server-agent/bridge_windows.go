//go:build windows

package main

import (
	"context"
	"io"

	"offmanual/desk/server-agent/internal/pipe"
)

func bridge(ctx context.Context, name, serverSID string, in io.Reader, out io.Writer) error {
	if name == "" {
		name = pipe.Name
	}
	return pipe.Bridge(ctx, name, serverSID, in, out)
}
