// Package app wires the Server Agent together: data directory, logs, store,
// secrets, handlers and the pipe listener. Both `server-agent run` (foreground)
// and the Windows service call Run.
package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"

	"offmanual/desk/server-agent/internal/agent"
	"offmanual/desk/server-agent/internal/pipe"
	"offmanual/desk/server-agent/internal/rpc"
	"offmanual/desk/server-agent/internal/secrets"
	"offmanual/desk/server-agent/internal/store"
	"offmanual/desk/server-agent/internal/version"
)

// Options configure one run.
type Options struct {
	DataDir  string // default: DefaultDataDir()
	PipeName string // default: pipe.Name
	Agent    agent.Config
	// LogWriter receives JSON logs in addition to the rotating file (stderr in foreground).
	LogWriter io.Writer
	// Ready, if set, is closed once the pipe is listening.
	Ready chan<- struct{}
}

// ErrUnsupported means the platform has no pipe listener (non-Windows).
var ErrUnsupported = errors.New("the Server Agent runs on Windows only")

// listen and protector are provided per platform.
var (
	listen    func(name string) (pipe.Acceptor, error)
	protector func() (secrets.Protector, error)
)

// Run starts the agent and blocks until ctx is cancelled.
func Run(ctx context.Context, o Options) error {
	if listen == nil {
		return ErrUnsupported
	}
	if o.DataDir == "" {
		o.DataDir = DefaultDataDir()
	}
	if o.PipeName == "" {
		o.PipeName = pipe.Name
	}
	if o.Agent.PortMin == 0 {
		o.Agent = agent.DefaultConfig()
	}
	if err := PrepareDataDir(o.DataDir); err != nil {
		return err
	}
	logFile, err := os.OpenFile(filepath.Join(o.DataDir, "logs", "server-agent.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open log: %w", err)
	}
	defer func() { _ = logFile.Close() }()
	var w io.Writer = logFile
	if o.LogWriter != nil {
		w = io.MultiWriter(logFile, o.LogWriter)
	}
	log := slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: slog.LevelInfo})).With("component", "server-agent")
	v := version.Get()
	log.Info("starting", "version", v.Version, "commit", v.Commit, "data_dir", o.DataDir)

	st, err := store.Open(ctx, filepath.Join(o.DataDir, "agent.db"))
	if err != nil {
		log.Error("store open failed", "error", err.Error())
		return err
	}
	defer func() { _ = st.Close() }()
	prot, err := protector()
	if err != nil {
		return err
	}
	startSync(ctx, st, prot, log, o.DataDir)
	srv := rpc.NewServer(log)
	agent.New(st, prot, o.Agent, log).Register(srv)

	l, err := listen(o.PipeName)
	if err != nil {
		log.Error("pipe listen failed", "error", err.Error())
		return err
	}
	log.Info("listening", "pipe", o.PipeName)
	if o.Ready != nil {
		close(o.Ready)
	}
	err = pipe.Serve(ctx, l, srv, log)
	log.Info("stopped")
	return err
}
