package agent

import (
	"context"
	"encoding/json"

	"offmanual/desk/server-agent/internal/rpc"
	"offmanual/desk/server-agent/pkg/manifest"
)

// updateStatus tells Desk which verified release is staged (UPDATES.md §4, ADR-048).
// Desk decides when its own gateway switches; the Server Agent never stops it.
func (a *Agent) updateStatus(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	if err := decode(p, &struct{}{}); err != nil {
		return nil, err
	}
	if _, err := a.employee(ctx, c, false); err != nil {
		return nil, err
	}
	r, err := a.store.StagedRelease(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]string{"staged": r.Version, "severity": r.Severity, "deadlineAt": ""}
	if r.Version == "" {
		out["severity"] = ""
	}
	if !r.Deadline.IsZero() {
		out["deadlineAt"] = rfc(r.Deadline)
	}
	return out, nil
}

// updateReport records which release the caller's gateway runs, so the firm admin can
// see who is still on an older one (UPDATES §4, ADR-063). Desk sends it after it reads
// update status; the SID comes from the pipe, never from the body.
func (a *Agent) updateReport(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		Version string `json:"version"`
	}
	if err := decode(p, &in); err != nil {
		return nil, err
	}
	if _, err := manifest.CompareVersions(in.Version, in.Version); err != nil {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params")
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	if err := a.store.SetRunningVersion(ctx, e.SID, in.Version); err != nil {
		return nil, err
	}
	return map[string]bool{"ok": true}, nil
}
