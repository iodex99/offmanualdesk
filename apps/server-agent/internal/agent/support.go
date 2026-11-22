package agent

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"offmanual/desk/server-agent/internal/rpc"
)

// Report a problem (ARCHITECTURE F11, ADR-050). The bundle holds metadata only:
// versions, licence, policy ETag, pre-flight results and the Server Agent's own log
// tail (which never contains client content). Desk shows it to the employee before
// anything is sent; the employee's description is the only free text.

// SupportSource collects the server part of a bundle (pre-flight, log tail).
type SupportSource func(ctx context.Context) (map[string]any, error)

// SupportSubmitter uploads a bundle to the console and returns the ticket reference.
type SupportSubmitter func(ctx context.Context, employeeID, description string, bundle map[string]any) (string, error)

// SetSupport wires the bundle source and the console upload (set by the app).
func (a *Agent) SetSupport(src SupportSource, submit SupportSubmitter) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.supportSource, a.supportUpload = src, submit
}

const MaxSupportDescription = 500

var deskKey = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9]{0,31}$`)

// deskInfo keeps a small flat map of short strings/bools/numbers from Desk.
func deskInfo(raw map[string]any) (map[string]any, bool) {
	if len(raw) > 16 {
		return nil, false
	}
	out := map[string]any{}
	for k, v := range raw {
		if !deskKey.MatchString(k) {
			return nil, false
		}
		switch x := v.(type) {
		case string:
			if utf8.RuneCountInString(x) > 120 {
				return nil, false
			}
			out[k] = x
		case bool, float64, nil:
			out[k] = x
		default:
			return nil, false
		}
	}
	return out, true
}

func (a *Agent) bundle(ctx context.Context, desk map[string]any) (map[string]any, error) {
	a.mu.Lock()
	src := a.supportSource
	a.mu.Unlock()
	server := map[string]any{}
	if src != nil {
		s, err := src(ctx)
		if err != nil {
			return nil, err
		}
		server = s
	}
	staged, _ := a.store.StagedRelease(ctx)
	etag, _ := a.store.Meta(ctx, "policy_etag")
	lic := a.Licence(ctx)
	server["stagedVersion"] = staged.Version
	server["policyEtag"] = etag
	server["licence"] = lic.Reason
	return map[string]any{"server": server, "desk": desk}, nil
}

// supportBundle returns the bundle preview for Desk (nothing is sent).
func (a *Agent) supportBundle(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		Desk map[string]any `json:"desk"`
	}
	if err := decode(p, &in); err != nil {
		return nil, err
	}
	desk, ok := deskInfo(in.Desk)
	if !ok {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params")
	}
	if _, err := a.employee(ctx, c, false); err != nil {
		return nil, err
	}
	b, err := a.bundle(ctx, desk)
	if err != nil {
		return nil, &rpc.Error{Code: rpc.CodeUnavailable, Message: "Off Manual couldn't collect the details. Try again."}
	}
	return b, nil
}

// supportSubmit rebuilds the bundle (the server part never comes from Desk) and uploads it.
func (a *Agent) supportSubmit(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		Description string         `json:"description"`
		Desk        map[string]any `json:"desk"`
	}
	if err := decode(p, &in); err != nil {
		return nil, err
	}
	desc := strings.TrimSpace(in.Description)
	desk, ok := deskInfo(in.Desk)
	// The console limit counts UTF-16 units (JavaScript string length); match it.
	if !ok || desc == "" || len(utf16.Encode([]rune(desc))) > MaxSupportDescription {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params")
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	submit := a.supportUpload
	a.mu.Unlock()
	if submit == nil {
		return nil, &rpc.Error{Code: rpc.CodeConflict, Message: MsgNotActivated}
	}
	b, err := a.bundle(ctx, desk)
	if err != nil {
		return nil, &rpc.Error{Code: rpc.CodeUnavailable, Message: "Off Manual couldn't collect the details. Try again."}
	}
	ref, err := submit(ctx, e.EmployeeID, desc, b)
	if err != nil {
		var um UserMessage
		if errors.As(err, &um) {
			return nil, &rpc.Error{Code: rpc.CodeConflict, Message: string(um)}
		}
		return nil, &rpc.Error{Code: rpc.CodeUnavailable, Message: "Off Manual couldn't send your report. Check the internet connection and try again."}
	}
	a.audit(ctx, e.SID, "task", "support_report", "ok")
	return map[string]string{"ticket": ref}, nil
}
