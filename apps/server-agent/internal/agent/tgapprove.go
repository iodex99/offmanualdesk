package agent

import (
	"context"
	"encoding/json"
	"regexp"
	"time"

	"offmanual/desk/server-agent/internal/rpc"
)

// Telegram "Approve" in place of the PIN (ADR-068, option b, accepted by Dwahnil on
// 25-11-2026). It never replaces the daily authenticator code: a request is only
// possible while today's code has been entered (day grant), the PIN is still allowed
// (fewer than three wrong PINs), there is no lockout, the licence is usable, the firm
// hasn't switched Telegram off, and the employee has linked Telegram. Every rule is
// checked again when the button is tapped, by the same linked Telegram account, within
// 60 seconds, once.

const (
	tgApprovalTTL   = 60 * time.Second
	tgMaxPerHour    = 5
	tgRequestIDSize = 16 // bytes → 32 hex
)

var tgRequestRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

// TelegramPrompter sends the Approve/Deny message to a linked Telegram user.
type TelegramPrompter func(ctx context.Context, telegramUserID int64, requestID, text string) error

// SetTelegramPrompter wires the bot (nil when Telegram isn't configured).
func (a *Agent) SetTelegramPrompter(p TelegramPrompter) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.tgPrompt = p
}

type tgApproval struct {
	sid     string
	expires time.Time
	status  string // pending | approved | denied | expired
}

var errTelegramApproveUnavailable = &rpc.Error{Code: rpc.CodeConflict,
	Message: "Approve on Telegram isn't available right now. Unlock with your PIN."}

// telegramApproveAllowed reports whether a PIN-level unlock by Telegram is allowed now.
func (a *Agent) telegramApproveAllowed(ctx context.Context, sid string) (int64, bool) {
	if a.TelegramMode(ctx) == "off" || a.PausedMessage(ctx) != "" {
		return 0, false
	}
	_, at, err := a.attempts(ctx, sid)
	if err != nil {
		return 0, false
	}
	now := a.now()
	if at.LockedOut(now) || !at.PINAllowed(now) {
		return 0, false
	}
	day, err := a.store.DayGrantValid(ctx, sid)
	if err != nil || !day {
		return 0, false
	}
	tg, err := a.store.TelegramUserForSID(ctx, sid)
	if err != nil {
		return 0, false
	}
	return tg, true
}

// TelegramApproveOffered is shown in session.hello so Desk only offers the button when it can work.
func (a *Agent) TelegramApproveOffered(ctx context.Context, sid string) bool {
	a.mu.Lock()
	ok := a.tgPrompt != nil
	a.mu.Unlock()
	if !ok {
		return false
	}
	_, allowed := a.telegramApproveAllowed(ctx, sid)
	return allowed
}

// unlockTelegramStart (Desk) sends Approve/Deny to the caller's linked Telegram.
func (a *Agent) unlockTelegramStart(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	if err := decode(p, &struct{}{}); err != nil {
		return nil, err
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	tg, ok := a.telegramApproveAllowed(ctx, e.SID)
	if !ok {
		return nil, errTelegramApproveUnavailable
	}
	id, err := randomHex(tgRequestIDSize)
	if err != nil {
		return nil, err
	}
	now := a.now()
	a.mu.Lock()
	prompt := a.tgPrompt
	if a.tgTries == nil {
		a.tgTries = map[string][]time.Time{}
	}
	if a.tgApprovals == nil {
		a.tgApprovals = map[string]*tgApproval{}
	}
	if prompt == nil {
		a.mu.Unlock()
		return nil, errTelegramApproveUnavailable
	}
	if a.limited(a.tgTries, e.SID, tgMaxPerHour, time.Hour) {
		a.mu.Unlock()
		return nil, &rpc.Error{Code: rpc.CodeConflict, Message: "Too many Telegram requests. Unlock with your PIN."}
	}
	for k, r := range a.tgApprovals {
		if r.sid == e.SID && r.status == "pending" {
			r.status = "expired" // only the newest request can be approved
		}
		if now.Sub(r.expires) > 10*time.Minute {
			delete(a.tgApprovals, k)
		}
	}
	a.tgApprovals[id] = &tgApproval{sid: e.SID, expires: now.Add(tgApprovalTTL), status: "pending"}
	a.mu.Unlock()

	text := "Unlock Off Manual Desk for " + e.Name + " at " + now.In(IST).Format("15:04") +
		" IST? Tap Approve only if you asked for this just now on your office computer."
	if err := prompt(ctx, tg, id, text); err != nil {
		a.mu.Lock()
		delete(a.tgApprovals, id)
		a.mu.Unlock()
		return nil, &rpc.Error{Code: rpc.CodeUnavailable, Message: "Telegram couldn't be reached. Unlock with your PIN."}
	}
	a.audit(ctx, e.SID, "auth", "telegram_approve_requested", "ok")
	return map[string]string{"requestId": id, "expiresAt": rfc(now.Add(tgApprovalTTL))}, nil
}

// unlockTelegramStatus (Desk) reports pending | approved | denied | expired for the caller's own request.
func (a *Agent) unlockTelegramStatus(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		RequestID string `json:"requestId"`
	}
	if err := decode(p, &in); err != nil || !tgRequestRe.MatchString(in.RequestID) {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params")
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	r, ok := a.tgApprovals[in.RequestID]
	if !ok || r.sid != e.SID {
		return map[string]string{"status": "expired"}, nil
	}
	if r.status == "pending" && !a.now().Before(r.expires) {
		r.status = "expired"
	}
	return map[string]string{"status": r.status}, nil
}

// TelegramDecision is called by the Telegram router when a button is tapped. It returns
// a short plain message for the person on Telegram.
func (a *Agent) TelegramDecision(ctx context.Context, telegramUserID int64, requestID string, approve bool) string {
	const gone = "This request has expired. Ask again from Off Manual Desk."
	if !tgRequestRe.MatchString(requestID) {
		return gone
	}
	a.mu.Lock()
	r, ok := a.tgApprovals[requestID]
	if !ok || r.status != "pending" || !a.now().Before(r.expires) {
		if ok && r.status == "pending" {
			r.status = "expired"
		}
		a.mu.Unlock()
		return gone
	}
	sid := r.sid
	a.mu.Unlock()

	// Only the Telegram account linked to this employee may answer, and every rule must still hold.
	linked, err := a.store.TelegramUserForSID(ctx, sid)
	if err != nil || linked != telegramUserID {
		return gone
	}
	if !approve {
		a.finishTelegramApproval(requestID, "denied")
		a.audit(ctx, sid, "auth", "telegram_approve", "denied")
		return "Denied. Off Manual Desk stays locked."
	}
	if _, err := a.employee(ctx, rpc.Caller{SID: sid}, false); err != nil {
		a.finishTelegramApproval(requestID, "denied")
		return "Your Off Manual access is switched off."
	}
	if _, allowed := a.telegramApproveAllowed(ctx, sid); !allowed {
		a.finishTelegramApproval(requestID, "expired")
		return "This can't be approved now. Use today's code from your authenticator app in Desk."
	}
	if !a.finishTelegramApproval(requestID, "approved") {
		return gone // answered twice, or expired in the meantime
	}
	l, err := a.store.Lock(ctx, sid)
	if err == nil {
		l.DeskLocked = false
		err = a.store.SaveLock(ctx, sid, l)
	}
	if err != nil {
		a.mu.Lock()
		r.status = "expired" // Desk must not treat it as unlocked
		a.mu.Unlock()
		a.log.Error("telegram approve unlock failed", "error", err.Error())
		return "Something went wrong. Unlock with your PIN."
	}
	a.audit(ctx, sid, "auth", "telegram_approve", "ok")
	return "Approved. Off Manual Desk is unlocked."
}

// finishTelegramApproval moves a pending, unexpired request to its final state once.
func (a *Agent) finishTelegramApproval(id, status string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	r, ok := a.tgApprovals[id]
	if !ok || r.status != "pending" || !a.now().Before(r.expires) {
		return false
	}
	r.status = status
	return true
}
