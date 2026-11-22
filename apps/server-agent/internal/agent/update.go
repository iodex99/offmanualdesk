package agent

import (
	"context"
	"encoding/json"

	"offmanual/desk/server-agent/internal/rpc"
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
