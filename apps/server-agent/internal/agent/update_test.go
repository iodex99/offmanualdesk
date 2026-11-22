package agent

import (
	"context"
	"offmanual/desk/server-agent/internal/rpc"
	"testing"
	"time"
)

func TestUpdateStatus(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if r := e.mustOK(asha, "update.status", nil); r["staged"] != "" || r["severity"] != "" {
		t.Fatalf("nothing staged: %v", r)
	}
	_ = e.st.SetUpdateState(ctx, "1.2.0", "staged", "")
	r := e.mustOK(asha, "update.status", nil)
	if r["staged"] != "1.2.0" || r["severity"] != "normal" || r["deadlineAt"] != "" {
		t.Fatalf("normal: %v", r)
	}
	deadline := time.Date(2026, 11, 30, 12, 0, 0, 0, time.UTC)
	_ = e.st.SetUpdateMeta(ctx, "1.2.0", "security", deadline)
	r = e.mustOK(asha, "update.status", nil)
	if r["severity"] != "security" || r["deadlineAt"] != rfc(deadline) {
		t.Fatalf("security: %v", r)
	}
	_ = e.st.SetUpdateMeta(ctx, "1.2.0", "weird", time.Time{})
	if r := e.mustOK(asha, "update.status", nil); r["severity"] != "normal" {
		t.Fatalf("unknown severity must read as normal: %v", r)
	}
	if _, errObj := e.call(nobod, "update.status", nil); errObj == nil {
		t.Fatal("unknown caller got update status")
	}
}

func TestUpdateReport(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.mustOK(asha, "update.report", map[string]string{"version": "1.2.0"})
	vs, _ := e.st.RunningVersions(ctx)
	if len(vs) != 1 || vs[0].Version != "1.2.0" || vs[0].EmployeeID != "emp-1101" {
		t.Fatalf("versions %+v", vs)
	}
	for _, bad := range []any{map[string]string{"version": "latest"}, map[string]string{}, map[string]any{"version": "1.2.0", "sid": ravi.SID}} {
		if _, errObj := e.call(asha, "update.report", bad); code(errObj) != rpc.CodeInvalidParams {
			t.Fatalf("%v accepted: %v", bad, errObj)
		}
	}
	if _, errObj := e.call(nobod, "update.report", map[string]string{"version": "1.2.0"}); errObj == nil {
		t.Fatal("unknown caller reported")
	}
}
