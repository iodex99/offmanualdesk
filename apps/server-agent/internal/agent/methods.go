package agent

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"offmanual/desk/server-agent/internal/auth"
	"offmanual/desk/server-agent/internal/rpc"
	"offmanual/desk/server-agent/internal/store"
)

// ---- session ----

type helloResult struct {
	Known       bool     `json:"known"`
	Name        string   `json:"name,omitempty"`
	Status      string   `json:"status,omitempty"`
	TOTPEnroled bool     `json:"totpEnrolled"`
	PINSet      bool     `json:"pinSet"`
	Locked      bool     `json:"locked"`
	DayUnlocked bool     `json:"dayUnlocked"`
	LockedUntil string   `json:"lockedUntil,omitempty"`
	Packs       []string `json:"packs,omitempty"`
	// Licence (ADR-042) so Desk can show a banner or the paused message.
	ServicePaused bool   `json:"servicePaused,omitempty"`
	PausedMessage string `json:"pausedMessage,omitempty"`
	Notice        string `json:"notice,omitempty"`
}

func (a *Agent) hello(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	if err := decode(p, &struct{}{}); err != nil {
		return nil, err
	}
	e, err := a.store.Employee(ctx, c.SID)
	if errors.Is(err, store.ErrNotFound) {
		return helloResult{Known: false, Locked: true}, nil
	}
	if err != nil {
		return nil, err
	}
	st, err := a.lockStatus(ctx, e.SID)
	if err != nil {
		return nil, err
	}
	return helloResult{Known: true, Name: e.Name, Status: e.Status, TOTPEnroled: !e.TOTPEnrolledAt.IsZero(),
		PINSet: e.PINHash != "", Locked: st.Locked, DayUnlocked: st.DayUnlocked, LockedUntil: st.LockedUntil, Packs: e.Packs,
		ServicePaused: st.ServicePaused, PausedMessage: st.PausedMessage, Notice: st.Notice}, nil
}

// ---- TOTP enrolment ----

func (a *Agent) totpEnrolStart(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		Account string `json:"account"` // shown in the employee's own authenticator app
	}
	if err := decode(p, &in); err != nil {
		return nil, err
	}
	e, err := a.employee(ctx, c, true)
	if err != nil {
		return nil, err
	}
	if !e.TOTPEnrolledAt.IsZero() {
		return nil, &rpc.Error{Code: rpc.CodeConflict, Message: "Your authenticator app is already set up. To move to a new phone, ask your admin to reset it."}
	}
	secret, err := auth.NewSecret()
	if err != nil {
		return nil, err
	}
	blob, err := a.secrets.Protect([]byte(secret))
	if err != nil {
		return nil, err
	}
	if err := a.store.SetTOTPSecret(ctx, e.SID, blob); err != nil {
		return nil, err
	}
	account := in.Account
	if account == "" || len(account) > 128 {
		account = e.Name
	}
	a.audit(ctx, e.SID, "auth", "totp_enrol_start", "ok")
	return map[string]string{"secret": secret, "uri": auth.ProvisioningURI(secret, account, auth.Default())}, nil
}

func (a *Agent) totpEnrolConfirm(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		Code string `json:"code"`
	}
	if err := decode(p, &in); err != nil {
		return nil, err
	}
	e, err := a.employee(ctx, c, true)
	if err != nil {
		return nil, err
	}
	if !e.TOTPEnrolledAt.IsZero() {
		return nil, &rpc.Error{Code: rpc.CodeConflict, Message: "Your authenticator app is already set up."}
	}
	if len(e.TOTPSecretDPAPI) == 0 {
		return nil, &rpc.Error{Code: rpc.CodeConflict, Message: "Start the authenticator setup again."}
	}
	// Verify against the unconfirmed secret (checkCode requires enrolment).
	secret, err := a.secrets.Unprotect(e.TOTPSecretDPAPI)
	if err != nil {
		return nil, err
	}
	counter, verr := auth.Verify(string(secret), in.Code, a.now(), 0, auth.DefaultSkew, auth.Default())
	if verr != nil {
		return nil, &rpc.Error{Code: rpc.CodeWrongCode, Message: "That code isn't right. Make sure you scanned the code on this screen, then enter the newest 6-digit code."}
	}
	if err := a.store.ConfirmTOTP(ctx, e.SID); err != nil {
		return nil, err
	}
	if err := a.store.AdvanceTOTPCounter(ctx, e.SID, counter); err != nil {
		return nil, err
	}
	codes, hashes, err := newRecoveryCodes()
	if err != nil {
		return nil, err
	}
	if err := a.store.SetRecoveryCodes(ctx, e.SID, hashes); err != nil {
		return nil, err
	}
	a.audit(ctx, e.SID, "auth", "totp_enrol_confirm", "ok")
	// Shown once (F2 step 4); only hashes are kept.
	return map[string]any{"enrolled": true, "recoveryCodes": codes}, nil
}

// ---- daily unlock, PIN, step-up ----

func (a *Agent) verifyDaily(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		Code string `json:"code"`
	}
	if err := decode(p, &in); err != nil {
		return nil, err
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	if err := a.checkCode(ctx, e, in.Code, "verify_daily"); err != nil {
		return nil, err
	}
	until := a.dayEnd(a.now())
	if err := a.store.GrantDay(ctx, e.SID, until); err != nil {
		return nil, err
	}
	l, err := a.store.Lock(ctx, e.SID)
	if err != nil {
		return nil, err
	}
	l.DeskLocked = false
	if err := a.store.SaveLock(ctx, e.SID, l); err != nil {
		return nil, err
	}
	a.audit(ctx, e.SID, "auth", "verify_daily", "ok")
	return map[string]string{"unlockedUntil": rfc(until)}, nil
}

func (a *Agent) pinSet(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		PIN  string `json:"pin"`
		Code string `json:"code"` // setting or resetting a PIN always needs a TOTP code
	}
	if err := decode(p, &in); err != nil {
		return nil, err
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	if err := auth.ValidatePIN(in.PIN); err != nil {
		msg := "Choose a PIN of 4 to 8 digits."
		if errors.Is(err, auth.ErrPINWeak) {
			msg = "That PIN is too easy to guess. Avoid repeated or running digits like 1111 or 1234."
		}
		return nil, &rpc.Error{Code: rpc.CodeInvalidParams, Message: msg}
	}
	if err := a.checkCode(ctx, e, in.Code, "pin_set"); err != nil {
		return nil, err
	}
	h, err := auth.HashPIN(in.PIN, auth.DefaultArgon)
	if err != nil {
		return nil, err
	}
	if err := a.store.SetPINHash(ctx, e.SID, h); err != nil {
		return nil, err
	}
	a.audit(ctx, e.SID, "auth", "pin_set", "ok")
	return map[string]bool{"pinSet": true}, nil
}

func (a *Agent) verifyPin(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		PIN string `json:"pin"`
	}
	if err := decode(p, &in); err != nil {
		return nil, err
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	now := a.now()
	l, at, err := a.attempts(ctx, e.SID)
	if err != nil {
		return nil, err
	}
	if at.LockedOut(now) {
		return nil, lockedOut(at.LockoutUntil)
	}
	day, err := a.store.DayGrantValid(ctx, e.SID)
	if err != nil {
		return nil, err
	}
	if !day || e.PINHash == "" || !at.PINAllowed(now) {
		return nil, &rpc.Error{Code: rpc.CodeLocked, Message: "Enter today's code from your authenticator app.", Data: map[string]any{"needDailyCode": true}}
	}
	rehash, verr := auth.VerifyPIN(e.PINHash, in.PIN)
	if verr != nil {
		out := at.PINFailed(now)
		if err := a.saveAttempts(ctx, e.SID, l, at); err != nil {
			return nil, err
		}
		a.audit(ctx, e.SID, "auth", "verify_pin", "wrong_pin")
		if out.NeedDailyCode {
			return nil, &rpc.Error{Code: rpc.CodeLocked, Message: "That PIN wasn't right three times. Enter today's code from your authenticator app.", Data: map[string]any{"needDailyCode": true}}
		}
		return nil, &rpc.Error{Code: rpc.CodeWrongCode, Message: "That PIN isn't right.", Data: map[string]any{"remaining": auth.MaxPINFailures - at.FailedPINs}}
	}
	if rehash {
		if h, err := auth.HashPIN(in.PIN, auth.DefaultArgon); err == nil {
			_ = a.store.SetPINHash(ctx, e.SID, h)
		}
	}
	at.PINSucceeded()
	l.DeskLocked = false
	if err := a.saveAttempts(ctx, e.SID, l, at); err != nil {
		return nil, err
	}
	return map[string]bool{"unlocked": true}, nil
}

var actionRe = regexp.MustCompile(`^[a-z][a-z0-9_.-]{1,47}$`)

func (a *Agent) stepUp(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		Code   string `json:"code"`
		Action string `json:"action"` // action class from the firm's step-up list, e.g. "tally.post"
	}
	if err := decode(p, &in); err != nil {
		return nil, err
	}
	if !actionRe.MatchString(in.Action) {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params")
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	if err := a.checkCode(ctx, e, in.Code, "step_up"); err != nil {
		return nil, err
	}
	id, err := randomHex(16)
	if err != nil {
		return nil, err
	}
	exp := a.now().Add(a.cfg.StepUpValidity)
	a.mu.Lock()
	for k, g := range a.stepUps {
		if a.now().After(g.expires) {
			delete(a.stepUps, k)
		}
	}
	a.stepUps[id] = stepUpGrant{sid: e.SID, action: in.Action, expires: exp}
	a.mu.Unlock()
	a.audit(ctx, e.SID, "auth", "step_up:"+in.Action, "ok")
	return map[string]string{"grantId": id, "expiresAt": rfc(exp)}, nil
}

// stepUpCheck lets the guard ask whether a grant is live for the caller (the SID
// comes from the OS, so one employee can't use another's grant) and action.
func (a *Agent) stepUpCheck(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		GrantID string `json:"grantId"`
		Action  string `json:"action"`
	}
	if err := decode(p, &in); err != nil || !actionRe.MatchString(in.Action) || len(in.GrantID) > 64 {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params")
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	return map[string]bool{"valid": a.StepUpValid(in.GrantID, e.SID, in.Action)}, nil
}

// StepUpValid reports whether grantID is a live step-up for sid and action
// (pipe method auth.stepUpCheck, used by the guard).
func (a *Agent) StepUpValid(grantID, sid, action string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	g, ok := a.stepUps[grantID]
	return ok && g.sid == sid && g.action == action && a.now().Before(g.expires)
}

// ---- lock ----

type lockStatus struct {
	Locked                bool   `json:"locked"`
	DayUnlocked           bool   `json:"dayUnlocked"`
	LockedUntil           string `json:"lockedUntil,omitempty"`
	TelegramUnlockedUntil string `json:"telegramUnlockedUntil,omitempty"`
	// Licence (BILLING §6): when servicePaused the guard refuses every turn with pausedMessage.
	ServicePaused bool   `json:"servicePaused,omitempty"`
	PausedMessage string `json:"pausedMessage,omitempty"`
	Notice        string `json:"notice,omitempty"`
}

func (a *Agent) lockStatus(ctx context.Context, sid string) (lockStatus, error) {
	l, err := a.store.Lock(ctx, sid)
	if err != nil {
		return lockStatus{}, err
	}
	day, err := a.store.DayGrantValid(ctx, sid)
	if err != nil {
		return lockStatus{}, err
	}
	now := a.now()
	st := lockStatus{Locked: l.DeskLocked || !day || now.Before(l.LockoutUntil), DayUnlocked: day}
	if now.Before(l.LockoutUntil) {
		st.LockedUntil = rfc(l.LockoutUntil)
	}
	if now.Before(l.TelegramUnlockedUntil) {
		st.TelegramUnlockedUntil = rfc(l.TelegramUnlockedUntil)
	}
	lic := a.Licence(ctx)
	st.ServicePaused, st.Notice = !lic.Usable, lic.Notice
	if !lic.Usable {
		st.PausedMessage = lic.Message
	}
	return st, nil
}

func (a *Agent) lockGet(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	if err := decode(p, &struct{}{}); err != nil {
		return nil, err
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	return a.lockStatus(ctx, e.SID)
}

func (a *Agent) lockSet(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		Locked *bool `json:"locked"`
	}
	if err := decode(p, &in); err != nil || in.Locked == nil {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params")
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	if !*in.Locked {
		// Unlocking only happens through verifyPin / verifyDaily / Telegram approval.
		return nil, &rpc.Error{Code: rpc.CodeUnauthorized, Message: "Unlock with your PIN or today's code."}
	}
	l, err := a.store.Lock(ctx, e.SID)
	if err != nil {
		return nil, err
	}
	l.DeskLocked = true
	if err := a.store.SaveLock(ctx, e.SID, l); err != nil {
		return nil, err
	}
	return a.lockStatus(ctx, e.SID)
}

// ---- gateway leases ----

func (a *Agent) gatewayLease(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	if err := decode(p, &struct{}{}); err != nil {
		return nil, err
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	st, err := a.lockStatus(ctx, e.SID)
	if err != nil {
		return nil, err
	}
	if st.Locked {
		return nil, errLocked
	}
	if _, err := a.store.ExpireLeases(ctx, a.now().Add(-a.cfg.LeaseStaleAfter)); err != nil {
		return nil, err
	}
	token, err := randomHex(32) // 256-bit gateway token (ADR-021)
	if err != nil {
		return nil, err
	}
	lease, err := a.store.AcquireLease(ctx, e.SID, a.cfg.PortMin, a.cfg.PortMax, HashToken(token))
	if errors.Is(err, store.ErrNoFreePort) {
		a.log.Error("gateway port range exhausted", "min", a.cfg.PortMin, "max", a.cfg.PortMax)
		return nil, &rpc.Error{Code: rpc.CodeConflict, Message: "The server is busy right now. Try again in a few minutes; if it keeps happening, tell your admin."}
	}
	if err != nil {
		return nil, err
	}
	// The relay (Telegram, ADR-023) connects to this gateway too: keep the token
	// DPAPI-protected next to its hash. agent.db is SYSTEM/Administrators only (ADR-033).
	if blob, perr := a.secrets.Protect([]byte(token)); perr == nil {
		_ = a.store.SetLeaseTokenProtected(ctx, e.SID, blob)
	}
	a.audit(ctx, e.SID, "gateway", "lease", "ok")
	// The token is returned once, to the employee's own process; only its hash is stored.
	return map[string]any{"port": lease.Port, "token": token}, nil
}

func (a *Agent) gatewayRelease(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	if err := decode(p, &struct{}{}); err != nil {
		return nil, err
	}
	if c.SID == "" {
		return nil, errNotSignedUp
	}
	if err := a.store.ReleaseLease(ctx, c.SID); err != nil {
		return nil, err
	}
	return map[string]bool{"released": true}, nil
}

// ---- audit ----

var auditCategories = map[string]bool{
	"access_denied": true, "access_request": true, "review_queued": true, "review_approved": true,
	"review_rejected": true, "tool_blocked": true, "telegram": true, "task": true, "lock": true,
}

func (a *Agent) auditAppend(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		Category      string `json:"category"`
		Action        string `json:"action"`
		Target        string `json:"target"`
		Result        string `json:"result"`
		CorrelationID string `json:"correlationId"`
	}
	if err := decode(p, &in); err != nil {
		return nil, err
	}
	if !auditCategories[in.Category] || !actionRe.MatchString(in.Action) || !actionRe.MatchString(in.Result) ||
		len(in.Target) > 1024 || len(in.CorrelationID) > 64 {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params")
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	// The target may be a path; it stays in the local audit log only (SECURITY §4).
	if err := a.store.AppendAudit(ctx, store.AuditEvent{SID: e.SID, Category: in.Category, Action: in.Action,
		Target: in.Target, Result: in.Result, CorrelationID: in.CorrelationID}); err != nil {
		return nil, err
	}
	return map[string]bool{"ok": true}, nil
}

// ---- policy ----

func (a *Agent) policyGet(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	if err := decode(p, &struct{}{}); err != nil {
		return nil, err
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	// Safe defaults until the console's firm policy has synced: Telegram off.
	out := map[string]any{
		"packs":          e.Packs,
		"telegramMode":   "off",
		"lockTimeoutMax": 15,
		"stepUpActions":  []string{},
		"dayEndHourIST":  a.cfg.DayEndHourIST,
		"generatedAt":    rfc(a.now()),
		"stepUpValidity": int(a.cfg.StepUpValidity / time.Second),
		"source":         "defaults",
	}
	if fp, ok := a.firmPolicy(ctx); ok {
		out["telegramMode"] = fp.TelegramMode
		out["lockTimeoutMax"] = fp.LockTimeoutMaxMin
		out["stepUpActions"] = fp.StepUpActions
		out["dayEndHourIST"] = fp.DayEndHourIST
		out["telegramAllowedPacks"] = fp.TelegramAllowedPacks
		out["gatewayIdleStopHours"] = fp.GatewayIdleStopHours
		out["source"] = "console"
	}
	return out, nil
}

// firmPolicy is the console policy as synced into meta "policy_json".
type firmPolicy struct {
	LockTimeoutMaxMin    int      `json:"lockTimeoutMaxMin"`
	DayEndHourIST        int      `json:"dayEndHourIst"`
	TelegramMode         string   `json:"telegramMode"`
	TelegramAllowedPacks []string `json:"telegramAllowedPacks"`
	StepUpActions        []string `json:"stepUpActions"`
	GatewayIdleStopHours int      `json:"gatewayIdleStopHours"`
}

func (a *Agent) firmPolicy(ctx context.Context) (firmPolicy, bool) {
	raw, err := a.store.Meta(ctx, "policy_json")
	if err != nil {
		return firmPolicy{}, false
	}
	var doc struct {
		Policy *firmPolicy `json:"policy"`
	}
	if json.Unmarshal([]byte(raw), &doc) != nil || doc.Policy == nil {
		return firmPolicy{}, false
	}
	switch doc.Policy.TelegramMode {
	case "off", "text", "files":
	default:
		doc.Policy.TelegramMode = "off" // unknown value: most restrictive
	}
	if doc.Policy.DayEndHourIST < 0 || doc.Policy.DayEndHourIST > 23 {
		doc.Policy.DayEndHourIST = a.cfg.DayEndHourIST
	}
	return *doc.Policy, true
}
