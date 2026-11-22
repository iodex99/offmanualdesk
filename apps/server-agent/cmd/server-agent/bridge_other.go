//go:build !windows

package main

import (
	"context"
	"io"

	"offmanual/desk/server-agent/internal/app"
)

func bridge(context.Context, string, string, io.Reader, io.Writer) error { return app.ErrUnsupported }
