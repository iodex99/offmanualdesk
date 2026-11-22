package agent

import (
	"context"
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
