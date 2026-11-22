package agent

import (
	"context"
	"errors"
	"testing"

	"offmanual/desk/server-agent/internal/rpc"
)

var newbie = rpc.Caller{SID: "S-1-5-21-100-200-300-1201", SessionID: 5, PID: 14}

func TestBindStart(t *testing.T) {
	e := newEnv(t)
	if _, errObj := e.call(newbie, "auth.bindStart", nil); errObj == nil || errObj["message"] != MsgNotActivated {
		t.Fatalf("not enrolled: %v", errObj)
	}
	_ = e.st.SetMeta(context.Background(), metaConsoleURL, "https://console.offmanual.in/")
	r := e.mustOK(newbie, "auth.bindStart", nil)
	if r["url"] != "https://console.offmanual.in/bind" {
		t.Fatalf("url %v", r)
	}
}

func TestBindCompleteUsesCallerSID(t *testing.T) {
	e := newEnv(t)
	if _, errObj := e.call(newbie, "auth.bindComplete", map[string]string{"code": "ABCD-EFGH"}); errObj == nil || errObj["message"] != MsgNotActivated {
		t.Fatalf("no binder: %v", errObj)
	}
	var gotSID string
	e.ag.SetBinder(func(_ context.Context, code, sid string) (BoundEmployee, error) {
		gotSID = sid
		switch code {
		case "ABCD-EFGH":
			return BoundEmployee{EmployeeID: "e-9", Name: "Neha", Status: "active", Packs: []string{"core"}}, nil
		case "USED-CODE":
			return BoundEmployee{}, UserMessage("That code isn't valid or has expired. Sign in again to get a new one.")
		default:
			return BoundEmployee{}, errors.New("dial tcp: no route")
		}
	})
	// A SID in the body is not a field: strict decoding refuses it (rule 4).
	if _, errObj := e.call(newbie, "auth.bindComplete", map[string]string{"code": "ABCD-EFGH", "sid": asha.SID}); errObj == nil {
		t.Fatal("extra sid field accepted")
	}
	if _, errObj := e.call(newbie, "auth.bindComplete", map[string]string{"code": "USED-CODE"}); errObj == nil || errObj["message"] != "That code isn't valid or has expired. Sign in again to get a new one." {
		t.Fatalf("console refusal: %v", errObj)
	}
	if _, errObj := e.call(newbie, "auth.bindComplete", map[string]string{"code": "NET-DOWN"}); errObj == nil || errObj["code"] != float64(rpc.CodeUnavailable) {
		t.Fatalf("network: %v", errObj)
	}
	r := e.mustOK(newbie, "auth.bindComplete", map[string]string{"code": "ABCD-EFGH"})
	if r["bound"] != true || r["name"] != "Neha" || gotSID != newbie.SID {
		t.Fatalf("bind: %v sid=%s", r, gotSID)
	}
	h := e.mustOK(newbie, "session.hello", nil)
	if h["known"] != true || h["name"] != "Neha" || h["totpEnrolled"] != false {
		t.Fatalf("hello after bind: %v", h)
	}
}

func TestBindCompleteLimitsAttemptsAndRefusesDisabled(t *testing.T) {
	e := newEnv(t)
	e.ag.SetBinder(func(context.Context, string, string) (BoundEmployee, error) {
		return BoundEmployee{}, UserMessage("nope")
	})
	for i := 0; i < bindMaxAttempts; i++ {
		e.call(newbie, "auth.bindComplete", map[string]string{"code": "X"})
	}
	if _, errObj := e.call(newbie, "auth.bindComplete", map[string]string{"code": "X"}); errObj == nil || errObj["code"] != float64(rpc.CodeLocked) {
		t.Fatalf("limit: %v", errObj)
	}
	e.advance(bindWindow + 1)
	if _, errObj := e.call(newbie, "auth.bindComplete", map[string]string{"code": "X"}); errObj == nil || errObj["message"] != "nope" {
		t.Fatalf("after window: %v", errObj)
	}
	_ = e.st.DisableEmployee(context.Background(), asha.SID)
	if _, errObj := e.call(asha, "auth.bindComplete", map[string]string{"code": "X"}); errObj == nil || errObj["message"] != errDisabled.Message {
		t.Fatalf("disabled: %v", errObj)
	}
}
