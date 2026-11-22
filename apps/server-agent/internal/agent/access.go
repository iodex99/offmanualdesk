package agent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"offmanual/desk/server-agent/internal/rpc"
	"offmanual/desk/server-agent/internal/store"
)

// Request access after an Access Denied (PRODUCT ease rule 6, ADR-058). Everything
// stays on this server: the denied path is shown to the employee and the firm's
// admins in Desk and never sent to the console. Off Manual doesn't change folder
// rights; the admin does that in Windows.

const maxAccessNote = 300

// accessDenials returns the caller's denials from the last 24 hours.
func (a *Agent) accessDenials(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	if err := decode(p, &struct{}{}); err != nil {
		return nil, err
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	list, err := a.store.RecentDenials(ctx, e.SID, a.now().Add(-24*time.Hour))
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(list))
	for _, d := range list {
		out = append(out, map[string]any{"id": d.ID, "at": rfc(d.At), "target": d.Target, "requested": d.Requested})
	}
	return map[string]any{"denials": out}, nil
}

// accessRequest sends a note about one of the caller's own denials to the admins.
func (a *Agent) accessRequest(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		ID   int64  `json:"id"`
		Note string `json:"note"`
	}
	if err := decode(p, &in); err != nil || in.ID <= 0 {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params")
	}
	note := strings.TrimSpace(in.Note)
	if note == "" || !utf8.ValidString(note) || utf8.RuneCountInString(note) > maxAccessNote {
		return nil, &rpc.Error{Code: rpc.CodeInvalidParams, Message: "Write a short note (up to 300 characters) saying why you need access."}
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	id, err := a.store.CreateAccessRequest(ctx, e.SID, in.ID, note)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return nil, &rpc.Error{Code: rpc.CodeConflict, Message: "That blocked folder isn't in your recent list any more."}
	case errors.Is(err, store.ErrAlreadyRequested):
		return nil, &rpc.Error{Code: rpc.CodeConflict, Message: "You've already asked for access to this."}
	case errors.Is(err, store.ErrTooManyRequests):
		return nil, &rpc.Error{Code: rpc.CodeConflict, Message: "You have many requests waiting. Ask your admin to look at them first."}
	case err != nil:
		return nil, err
	}
	a.audit(ctx, e.SID, "access_request", "requested", "ok")
	return map[string]any{"id": id}, nil
}

// accessList returns requests: all of them for a firm admin, else the caller's own.
func (a *Agent) accessList(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	if err := decode(p, &struct{}{}); err != nil {
		return nil, err
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	admin, err := a.store.IsAdmin(ctx, e.SID)
	if err != nil {
		return nil, err
	}
	list, err := a.store.AccessRequests(ctx, e.SID, admin)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(list))
	for _, r := range list {
		m := map[string]any{"id": r.ID, "name": r.Name, "target": r.Target, "note": r.Note,
			"createdAt": rfc(r.CreatedAt), "status": r.Status, "mine": r.SID == e.SID}
		if !r.ResolvedAt.IsZero() {
			m["resolvedAt"] = rfc(r.ResolvedAt)
		}
		out = append(out, m)
	}
	return map[string]any{"admin": admin, "requests": out}, nil
}

// accessResolve lets a firm admin mark a request done or declined.
func (a *Agent) accessResolve(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		ID      int64  `json:"id"`
		Outcome string `json:"outcome"`
	}
	if err := decode(p, &in); err != nil || in.ID <= 0 || (in.Outcome != "done" && in.Outcome != "declined") {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params")
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	admin, err := a.store.IsAdmin(ctx, e.SID)
	if err != nil {
		return nil, err
	}
	if !admin {
		return nil, &rpc.Error{Code: rpc.CodeUnauthorized, Message: "Only your firm's admins can close access requests."}
	}
	if err := a.store.ResolveAccessRequest(ctx, in.ID, e.SID, in.Outcome); errors.Is(err, store.ErrNotFound) {
		return nil, &rpc.Error{Code: rpc.CodeConflict, Message: "That request is already closed."}
	} else if err != nil {
		return nil, err
	}
	a.audit(ctx, e.SID, "access_request", in.Outcome, "ok")
	return map[string]bool{"ok": true}, nil
}
