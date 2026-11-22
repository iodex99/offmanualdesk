package agent

import (
	"context"
	"encoding/json"

	"offmanual/desk/server-agent/internal/rpc"
)

// Per-call bounds: the guard flushes about once a minute, so real numbers are far below these.
const (
	maxTurnsPerCall  = 10_000
	maxTokensPerCall = 1_000_000_000
)

// usageAdd records counts from the guard for the caller (ADR-051). Counts only.
func (a *Agent) usageAdd(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		Turns        *int64 `json:"turns"`
		InputTokens  *int64 `json:"inputTokens"`
		OutputTokens *int64 `json:"outputTokens"`
	}
	if err := decode(p, &in); err != nil || in.Turns == nil || in.InputTokens == nil || in.OutputTokens == nil ||
		*in.Turns < 0 || *in.Turns > maxTurnsPerCall ||
		*in.InputTokens < 0 || *in.InputTokens > maxTokensPerCall ||
		*in.OutputTokens < 0 || *in.OutputTokens > maxTokensPerCall {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params")
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	day := a.now().In(IST).Format("2006-01-02")
	if err := a.store.AddUsage(ctx, e.SID, day, *in.Turns, *in.InputTokens, *in.OutputTokens); err != nil {
		return nil, err
	}
	return map[string]bool{"ok": true}, nil
}
