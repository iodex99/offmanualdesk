//go:build !windows

package app

import (
	"context"
	"errors"
	"testing"
)

func TestRunIsWindowsOnly(t *testing.T) {
	if err := Run(context.Background(), Options{DataDir: t.TempDir()}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("want ErrUnsupported, got %v", err)
	}
}
