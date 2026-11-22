package agent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"offmanual/desk/server-agent/internal/rpc"
	"offmanual/desk/server-agent/internal/store"
)

// BoundEmployee is what the console returns after binding (ARCHITECTURE F2, ADR-044).
type BoundEmployee struct {
	EmployeeID string   `json:"employeeId"`
	Name       string   `json:"name"`
	Status     string   `json:"status"`
	Packs      []string `json:"packs"`
}

// Binder redeems a code at the console for sid. A UserMessage error is shown as is.
type Binder func(ctx context.Context, code, sid string) (BoundEmployee, error)

// SetBinder wires the console call (set by the app when the server is enrolled).
func (a *Agent) SetBinder(b Binder) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.binder = b
}

const (
	bindMaxAttempts = 10
	bindWindow      = time.Hour
	metaConsoleURL  = "console_url"
)

// bindStart returns the console page where the employee signs in to get a code.
func (a *Agent) bindStart(ctx context.Context, _ rpc.Caller, p json.RawMessage) (any, error) {
	if err := decode(p, &struct{}{}); err != nil {
		return nil, err
	}
	u, err := a.store.Meta(ctx, metaConsoleURL)
	if err != nil || !strings.HasPrefix(u, "https://") {
		return nil, &rpc.Error{Code: rpc.CodeConflict, Message: MsgNotActivated}
	}
	return map[string]string{"url": strings.TrimRight(u, "/") + "/bind"}, nil
}

// bindComplete redeems the code the employee typed, for the caller's OS-derived SID
// (rule 4: never a SID from the request), then records the employee locally so Desk
// can continue straight away (the next policy sync confirms it).
func (a *Agent) bindComplete(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		Code string `json:"code"`
	}
	if err := decode(p, &in); err != nil || len(in.Code) == 0 || len(in.Code) > 20 {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params")
	}
	if e, err := a.store.Employee(ctx, c.SID); err == nil && e.Status == "disabled" {
		return nil, errDisabled
	}
	a.mu.Lock()
	b := a.binder
	if a.bindTries == nil {
		a.bindTries = map[string][]time.Time{}
	}
	tooMany := a.limited(a.bindTries, c.SID, bindMaxAttempts, bindWindow)
	a.mu.Unlock()
	if tooMany {
		return nil, &rpc.Error{Code: rpc.CodeLocked, Message: "Too many tries. Wait an hour, or ask your admin for help."}
	}
	if b == nil {
		return nil, &rpc.Error{Code: rpc.CodeConflict, Message: MsgNotActivated}
	}
	bound, err := b(ctx, in.Code, c.SID)
	if err != nil {
		var um UserMessage
		if errors.As(err, &um) {
			a.audit(ctx, c.SID, "lock", "bind", "refused")
			return nil, &rpc.Error{Code: rpc.CodeUnauthorized, Message: string(um)}
		}
		return nil, &rpc.Error{Code: rpc.CodeUnavailable, Message: "Off Manual couldn't reach its servers. Check the internet connection and try again."}
	}
	if bound.EmployeeID == "" || bound.Status != "active" {
		return nil, &rpc.Error{Code: rpc.CodeUnavailable, Message: "Unexpected reply from Off Manual's servers. Try again."}
	}
	if err := a.store.UpsertEmployee(ctx, store.Employee{SID: c.SID, EmployeeID: bound.EmployeeID, Name: bound.Name,
		Status: "active", Packs: bound.Packs}); err != nil {
		return nil, err
	}
	a.audit(ctx, c.SID, "lock", "bind", "ok")
	return map[string]any{"bound": true, "name": bound.Name}, nil
}
