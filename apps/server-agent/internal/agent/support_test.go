package agent

import (
	"context"
	"errors"
	"strings"
	"testing"

	"offmanual/desk/server-agent/internal/rpc"
)

func TestSupportBundlePreviewAndSubmit(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_ = e.st.SetMeta(ctx, "policy_etag", `"p7"`)
	e.ag.SetSupport(func(context.Context) (map[string]any, error) {
		return map[string]any{"agentVersion": "1.2.0", "logTail": []string{"line"}}, nil
	}, nil)

	desk := map[string]any{"deskVersion": "1.2.0", "gatewayRunning": true}
	b := e.mustOK(asha, "support.bundle", map[string]any{"desk": desk})
	server := b["server"].(map[string]any)
	if server["agentVersion"] != "1.2.0" || server["policyEtag"] != `"p7"` || server["licence"] != "not_activated" {
		t.Fatalf("server part: %v", server)
	}
	if b["desk"].(map[string]any)["deskVersion"] != "1.2.0" {
		t.Fatalf("desk part: %v", b["desk"])
	}
	// Desk details are small and flat.
	for _, bad := range []map[string]any{
		{"nested": map[string]any{"x": 1}},
		{"bad key!": "x"},
		{"long": strings.Repeat("x", 121)},
	} {
		if _, errObj := e.call(asha, "support.bundle", map[string]any{"desk": bad}); code(errObj) != rpc.CodeInvalidParams {
			t.Fatalf("accepted %v", bad)
		}
	}

	// No console yet: plain message.
	if _, errObj := e.call(asha, "support.submit", map[string]any{"description": "Desk is slow"}); errObj == nil || errObj["message"] != MsgNotActivated {
		t.Fatalf("no submitter: %v", errObj)
	}
	var gotEmployee, gotDesc string
	var gotBundle map[string]any
	e.ag.SetSupport(func(context.Context) (map[string]any, error) { return map[string]any{"agentVersion": "1.2.0"}, nil },
		func(_ context.Context, employeeID, description string, bundle map[string]any) (string, error) {
			gotEmployee, gotDesc, gotBundle = employeeID, description, bundle
			switch description {
			case "quota":
				return "", UserMessage("Too many reports today. Try again tomorrow.")
			case "offline":
				return "", errors.New("dial tcp")
			}
			return "OM-1234", nil
		})
	r := e.mustOK(asha, "support.submit", map[string]any{"description": "  Desk is slow  ", "desk": desk})
	if r["ticket"] != "OM-1234" || gotDesc != "Desk is slow" || gotEmployee == "" {
		t.Fatalf("submit: %v %q %q", r, gotDesc, gotEmployee)
	}
	if gotBundle["server"].(map[string]any)["agentVersion"] != "1.2.0" {
		t.Fatalf("server part must be rebuilt by the agent: %v", gotBundle)
	}
	if _, errObj := e.call(asha, "support.submit", map[string]any{"description": "quota"}); errObj == nil || errObj["message"] != "Too many reports today. Try again tomorrow." {
		t.Fatalf("user message: %v", errObj)
	}
	if _, errObj := e.call(asha, "support.submit", map[string]any{"description": "offline"}); code(errObj) != rpc.CodeUnavailable {
		t.Fatalf("offline: %v", errObj)
	}
	for _, d := range []string{"", "   ", strings.Repeat("x", MaxSupportDescription+1)} {
		if _, errObj := e.call(asha, "support.submit", map[string]any{"description": d}); code(errObj) != rpc.CodeInvalidParams {
			t.Fatalf("description %d chars accepted", len(d))
		}
	}
	if _, errObj := e.call(nobod, "support.submit", map[string]any{"description": "hi"}); errObj == nil {
		t.Fatal("unknown caller submitted")
	}
}
