package agent

import (
	"context"
	"testing"
	"time"

	"offmanual/desk/server-agent/internal/rpc"
	"offmanual/desk/server-agent/internal/store"
)

const (
	nAll    = "11111111-1111-4111-8111-111111111111"
	nAdmins = "22222222-2222-4222-8222-222222222222"
)

func TestNoticesAudienceAndDismiss(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_ = e.st.SetEmployeeAdmin(ctx, asha.SID, true)
	err := e.st.ReplaceNotices(ctx, []store.Notice{
		{ID: nAll, Kind: "update", Audience: "all", Title: "Maintenance tonight", Body: "Desk restarts at 22:00 IST.", Created: e.clock},
		{ID: nAdmins, Kind: "billing", Audience: "admins", Title: "Invoice issued", Body: "Due on 16-12-2026.", Created: e.clock.Add(time.Minute)},
	})
	if err != nil {
		t.Fatal(err)
	}
	titles := func(c rpc.Caller) []string {
		r := e.mustOK(c, "notices.list", nil)
		var out []string
		for _, n := range r["notices"].([]any) {
			out = append(out, n.(map[string]any)["title"].(string))
		}
		return out
	}
	if got := titles(asha); len(got) != 2 {
		t.Fatalf("admin sees %v", got)
	}
	if got := titles(ravi); len(got) != 1 || got[0] != "Maintenance tonight" {
		t.Fatalf("employee sees %v", got)
	}
	e.mustOK(ravi, "notices.ack", map[string]string{"id": nAll})
	if got := titles(ravi); len(got) != 0 {
		t.Fatalf("after dismiss %v", got)
	}
	if got := titles(asha); len(got) != 2 {
		t.Fatalf("another employee's dismissal affected asha: %v", got)
	}
	if _, errObj := e.call(ravi, "notices.ack", map[string]string{"id": "not-a-uuid"}); code(errObj) != rpc.CodeInvalidParams {
		t.Fatalf("bad id: %v", errObj)
	}
	// The console stops sending a notice: it disappears with its dismissals.
	_ = e.st.ReplaceNotices(ctx, []store.Notice{{ID: nAdmins, Kind: "billing", Audience: "admins", Title: "Invoice issued", Body: "x", Created: e.clock}})
	if got := titles(ravi); len(got) != 0 {
		t.Fatalf("ravi after replace %v", got)
	}
	if got := titles(asha); len(got) != 1 || got[0] != "Invoice issued" {
		t.Fatalf("asha after replace %v", got)
	}
	if _, errObj := e.call(nobod, "notices.list", nil); errObj == nil {
		t.Fatal("unknown caller listed notices")
	}
}
