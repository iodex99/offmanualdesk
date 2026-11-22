//go:build windows

package app

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"offmanual/desk/server-agent/internal/pipe"
)

// End to end on a real pipe: Run → dial → session.hello → shutdown.
func TestRunServesPipeAndShutsDown(t *testing.T) {
	dir := t.TempDir()
	name := fmt.Sprintf(`\\.\pipe\offmanual-apptest-%d-%d`, os.Getpid(), time.Now().UnixNano())
	ready := make(chan struct{})
	var logs bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Run(ctx, Options{DataDir: dir, PipeName: name, Ready: ready, LogWriter: &logs}) }()
	select {
	case <-ready:
	case err := <-done:
		t.Fatalf("Run exited early: %v", err)
	case <-time.After(20 * time.Second):
		t.Fatal("not ready")
	}
	conn, err := pipe.Dial(context.Background(), name)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = conn.Write([]byte(`{"jsonrpc":"2.0","id":1,"method":"session.hello","params":{}}` + "\n"))
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || !strings.Contains(line, `"known":false`) {
		t.Fatalf("hello: %q %v", line, err)
	}
	_ = conn.Close()
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run: %v", err)
	}
	for _, f := range []string{"agent.db", filepath.Join("logs", "server-agent.log")} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Errorf("missing %s: %v", f, err)
		}
	}
	if !strings.Contains(logs.String(), `"msg":"listening"`) || !strings.Contains(logs.String(), `"msg":"stopped"`) {
		t.Fatalf("lifecycle not logged: %s", logs.String())
	}
}

func TestProtectDirAppliesSystemAdminsOnly(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "OffManual")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := ProtectDir(dir); err != nil {
		t.Fatal(err)
	}
	// As the folder's owner we keep implicit READ_CONTROL and WRITE_DAC.
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	got := sd.String()
	if !strings.HasPrefix(got, "D:PAI") || !strings.Contains(got, "(A;OICI;FA;;;SY)") || !strings.Contains(got, "(A;OICI;FA;;;BA)") || strings.Count(got, "(A;") != 2 {
		t.Fatalf("DACL %s, want SYSTEM + Administrators only", got)
	}
	// Give ourselves access back so t.TempDir can clean up.
	me, _ := windows.GetCurrentProcessToken().GetTokenUser()
	restore, _ := windows.SecurityDescriptorFromString("D:(A;OICI;FA;;;" + me.User.Sid.String() + ")")
	dacl, _, _ := restore.DACL()
	_ = windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

func TestDefaultDataDir(t *testing.T) {
	if !strings.HasSuffix(strings.ToLower(DefaultDataDir()), `\offmanual`) {
		t.Fatalf("DefaultDataDir = %s", DefaultDataDir())
	}
}
