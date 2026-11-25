//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"offmanual/desk/server-agent/internal/app"
)

func isService() bool {
	ok, err := svc.IsWindowsService()
	return err == nil && ok
}

type handler struct{ dataDir string }

// Execute implements svc.Handler: run the agent until Stop/Shutdown.
func (h handler) Execute(_ []string, req <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	ready := make(chan struct{})
	go func() { done <- app.Run(ctx, app.Options{DataDir: h.dataDir, Ready: ready}) }()
	select {
	case <-ready:
	case err := <-done:
		cancel()
		_ = err // already logged by app.Run
		return true, 1
	}
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				status <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				select {
				case err := <-done:
					if err != nil {
						return true, 3 // stopped with an error (logged by app.Run)
					}
				case <-time.After(20 * time.Second):
					return true, 4 // did not stop in time
				}
				return false, 0
			}
		case err := <-done:
			// The agent stopped on its own: exit non-zero so SCM recovery restarts it.
			cancel()
			if err == nil {
				return true, 5
			}
			return true, 2
		}
	}
}

func runService() error {
	data := ""
	if len(os.Args) > 2 && os.Args[1] == "service" {
		data = os.Args[2]
	}
	return svc.Run(ServiceName, handler{dataDir: data})
}

func installService(dataDir string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	// Register through `current` so a switch to a new release takes effect at restart (ADR-062).
	exe = app.ServiceBinaryPath(exe)
	if dataDir == "" {
		dataDir = app.DefaultDataDir()
	}
	if err := app.PrepareDataDir(dataDir); err != nil {
		return err
	}
	if err := app.ProtectDir(dataDir); err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to service manager (run as Administrator): %w", err)
	}
	defer func() { _ = m.Disconnect() }()
	if s, err := m.OpenService(ServiceName); err == nil {
		_ = s.Close()
		return fmt.Errorf("%s is already installed", ServiceName)
	}
	s, err := m.CreateService(ServiceName, exe, mgr.Config{
		DisplayName:      "Off Manual Server Agent",
		Description:      "Licence, updates, sign-in checks, gateway leases and audit for Off Manual Desk.",
		StartType:        mgr.StartAutomatic,
		DelayedAutoStart: true,
		ServiceStartName: "LocalSystem",
	}, "service", dataDir)
	if err != nil {
		return fmt.Errorf("create service: %w", err)
	}
	defer func() { _ = s.Close() }()
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 2 * time.Minute},
	}, uint32((24 * time.Hour).Seconds())); err != nil {
		return fmt.Errorf("set recovery actions: %w", err)
	}
	// Also restart after the agent stops itself with an error (e.g. to run a new release,
	// ADR-062); without this flag SCM only acts on crashes.
	if err := s.SetRecoveryActionsOnNonCrashFailures(true); err != nil {
		return fmt.Errorf("set recovery on non-crash failures: %w", err)
	}
	return s.Start()
}

func uninstallService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to service manager (run as Administrator): %w", err)
	}
	defer func() { _ = m.Disconnect() }()
	s, err := m.OpenService(ServiceName)
	if err != nil {
		return fmt.Errorf("%s is not installed", ServiceName)
	}
	defer func() { _ = s.Close() }()
	if st, err := s.Control(svc.Stop); err == nil {
		deadline := time.Now().Add(30 * time.Second)
		for st.State != svc.Stopped && time.Now().Before(deadline) {
			time.Sleep(300 * time.Millisecond)
			if st, err = s.Query(); err != nil {
				break
			}
		}
	} else if !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
		return fmt.Errorf("stop service: %w", err)
	}
	return s.Delete()
}

// serviceInstalled reports whether the OffManualAgent service exists.
func serviceInstalled() bool {
	m, err := mgr.Connect()
	if err != nil {
		return false
	}
	defer func() { _ = m.Disconnect() }()
	s, err := m.OpenService(ServiceName)
	if err != nil {
		return false
	}
	_ = s.Close()
	return true
}
