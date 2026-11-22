package agent

import (
	"context"
	"strings"
	"testing"
	"time"

	"offmanual/desk/server-agent/internal/rpc"
)

func deny(t *testing.T, e *env, c rpc.Caller, target string) {
	t.Helper()
	e.mustOK(c, "audit.append", map[string]string{"category": "access_denied", "action": "read", "target": target, "result": "denied"})
}

func denials(e *env, c rpc.Caller) []map[string]any {
	var out []map[string]any
	for _, d := range e.mustOK(c, "access.denials", nil)["denials"].([]any) {
		out = append(out, d.(map[string]any))
	}
	return out
}

func TestAccessRequestFlow(t *testing.T) {
	e := newEnv(t)
	e.st.SetClock(func() time.Time { return e.clock })
	ctx := context.Background()
	_ = e.st.SetEmployeeAdmin(ctx, asha.SID, true)

	deny(t, e, ravi, `\\fs01\Clients\Mehta Traders`)
	got := denials(e, ravi)
	if len(got) != 1 || got[0]["target"] != `\\fs01\Clients\Mehta Traders` || got[0]["requested"] != false {
		t.Fatalf("denials %v", got)
	}
	if len(denials(e, asha)) != 0 {
		t.Fatal("another employee's denial listed")
	}
	id := got[0]["id"]

	// Asha can't request access with Ravi's denial (the path comes from the row, not the body).
	if _, errObj := e.call(asha, "access.request", map[string]any{"id": id, "note": "x"}); errObj == nil {
		t.Fatal("request on someone else's denial accepted")
	}
	if _, errObj := e.call(ravi, "access.request", map[string]any{"id": id, "note": "   "}); code(errObj) != rpc.CodeInvalidParams {
		t.Fatalf("empty note: %v", errObj)
	}
	if _, errObj := e.call(ravi, "access.request", map[string]any{"id": id, "note": strings.Repeat("a", 301)}); code(errObj) != rpc.CodeInvalidParams {
		t.Fatalf("long note: %v", errObj)
	}
	if _, errObj := e.call(ravi, "access.request", map[string]any{"id": id, "note": "GST return", "target": `C:\Windows`}); code(errObj) != rpc.CodeInvalidParams {
		t.Fatalf("extra target field accepted: %v", errObj)
	}
	e.mustOK(ravi, "access.request", map[string]any{"id": id, "note": "Need it for the October GST return."})
	if _, errObj := e.call(ravi, "access.request", map[string]any{"id": id, "note": "again"}); code(errObj) != rpc.CodeConflict {
		t.Fatalf("second request: %v", errObj)
	}
	if denials(e, ravi)[0]["requested"] != true {
		t.Fatal("denial not marked requested")
	}

	// Ravi sees his own; Asha (admin) sees everyone's and can close it; Ravi can't.
	mine := e.mustOK(ravi, "access.list", nil)
	if mine["admin"] != false || len(mine["requests"].([]any)) != 1 {
		t.Fatalf("ravi list %v", mine)
	}
	all := e.mustOK(asha, "access.list", nil)
	reqs := all["requests"].([]any)
	if all["admin"] != true || len(reqs) != 1 {
		t.Fatalf("admin list %v", all)
	}
	r := reqs[0].(map[string]any)
	if r["target"] != `\\fs01\Clients\Mehta Traders` || r["name"] != "Employee 1102" || r["status"] != "open" || r["mine"] != false {
		t.Fatalf("request %v", r)
	}
	if _, errObj := e.call(ravi, "access.resolve", map[string]any{"id": r["id"], "outcome": "done"}); code(errObj) != rpc.CodeUnauthorized {
		t.Fatalf("non-admin resolved: %v", errObj)
	}
	if _, errObj := e.call(asha, "access.resolve", map[string]any{"id": r["id"], "outcome": "maybe"}); code(errObj) != rpc.CodeInvalidParams {
		t.Fatalf("bad outcome: %v", errObj)
	}
	e.mustOK(asha, "access.resolve", map[string]any{"id": r["id"], "outcome": "done"})
	if _, errObj := e.call(asha, "access.resolve", map[string]any{"id": r["id"], "outcome": "declined"}); code(errObj) != rpc.CodeConflict {
		t.Fatalf("closed twice: %v", errObj)
	}
	status := e.mustOK(ravi, "access.list", nil)["requests"].([]any)[0].(map[string]any)
	if status["status"] != "done" || status["resolvedAt"] == "" {
		t.Fatalf("ravi sees %v", status)
	}
	// Resolved requests drop off after a week; denials after a day.
	e.advance(8 * 24 * time.Hour)
	if len(e.mustOK(ravi, "access.list", nil)["requests"].([]any)) != 0 || len(denials(e, ravi)) != 0 {
		t.Fatal("old items still listed")
	}
	if hello := e.mustOK(asha, "session.hello", nil); hello["admin"] != true {
		t.Fatalf("hello %v", hello)
	}
	if hello := e.mustOK(ravi, "session.hello", nil); hello["admin"] != nil {
		t.Fatalf("hello %v", hello)
	}
	if _, errObj := e.call(nobod, "access.denials", nil); errObj == nil {
		t.Fatal("unknown caller listed denials")
	}
}

func TestAccessRequestOpenLimit(t *testing.T) {
	e := newEnv(t)
	e.st.SetClock(func() time.Time { return e.clock })
	for i := 0; i < 21; i++ {
		deny(t, e, ravi, `C:\Clients\c`+string(rune('a'+i)))
	}
	// Only the newest 10 are listed; request through store ids directly.
	ds, err := e.st.RecentDenials(context.Background(), ravi.SID, e.clock.Add(-time.Hour))
	if err != nil || len(ds) != 10 {
		t.Fatalf("%d %v", len(ds), err)
	}
	for i := int64(1); i <= 20; i++ {
		e.mustOK(ravi, "access.request", map[string]any{"id": i, "note": "need it"})
	}
	if _, errObj := e.call(ravi, "access.request", map[string]any{"id": 21, "note": "need it"}); code(errObj) != rpc.CodeConflict {
		t.Fatalf("21st open request: %v", errObj)
	}
}
