package agent

import (
	"context"
	"encoding/json"
	"regexp"

	"offmanual/desk/server-agent/internal/rpc"
)

var noticeID = regexp.MustCompile(`^[0-9a-f-]{36}$`)

// noticesList returns the caller's notices (ADR-052).
func (a *Agent) noticesList(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	if err := decode(p, &struct{}{}); err != nil {
		return nil, err
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	list, err := a.store.NoticesFor(ctx, e.SID)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]string, 0, len(list))
	for _, n := range list {
		out = append(out, map[string]string{"id": n.ID, "kind": n.Kind, "title": n.Title, "body": n.Body, "createdAt": rfc(n.Created)})
	}
	return map[string]any{"notices": out}, nil
}

// noticesAck dismisses a notice for the caller.
func (a *Agent) noticesAck(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		ID string `json:"id"`
	}
	if err := decode(p, &in); err != nil || !noticeID.MatchString(in.ID) {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params")
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	if err := a.store.AckNotice(ctx, in.ID, e.SID); err != nil {
		return nil, err
	}
	return map[string]bool{"ok": true}, nil
}
