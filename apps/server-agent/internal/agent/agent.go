// Package agent implements the Server Agent's pipe methods (docs/ARCHITECTURE.md
// §3.1, flows F2–F4) on top of the store, auth and secrets packages.
//
// Every handler works only on the caller's own SID, which comes from the OS
// (rpc.Caller); no method accepts a SID, username or role in its params.
// Messages returned to Desk are plain language with a next step (PRODUCT.md §4).
package agent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"offmanual/desk/server-agent/internal/auth"
	"offmanual/desk/server-agent/internal/rpc"
	"offmanual/desk/server-agent/internal/secrets"
	"offmanual/desk/server-agent/internal/store"
)

// IST is India Standard Time (no daylight saving).
var IST = time.FixedZone("IST", 5*3600+1800)

// Config holds firm-level settings (from policy in M3; defaults until then).
type Config struct {
	PortMin, PortMax int
	DayEndHourIST    int           // daily unlock lasts until this hour (IST), next occurrence
	StepUpValidity   time.Duration // ARCHITECTURE F3: 10 minutes
	LeaseStaleAfter  time.Duration
}

// DefaultConfig matches ARCHITECTURE §4 and F3.
func DefaultConfig() Config {
	return Config{PortMin: 18800, PortMax: 19799, DayEndHourIST: 22, StepUpValidity: 10 * time.Minute, LeaseStaleAfter: 12 * time.Hour}
}

// Agent holds dependencies for the handlers.
type Agent struct {
	store   *store.Store
	secrets secrets.Protector
	cfg     Config
	now     func() time.Time
	log     *slog.Logger

	mu      sync.Mutex
	stepUps map[string]stepUpGrant // grant ID → grant (in memory; restart clears)
}

type stepUpGrant struct {
	sid, action string
	expires     time.Time
}

// New builds an Agent.
func New(st *store.Store, p secrets.Protector, cfg Config, log *slog.Logger) *Agent {
	if log == nil {
		log = slog.Default()
	}
	return &Agent{store: st, secrets: p, cfg: cfg, now: time.Now, log: log, stepUps: map[string]stepUpGrant{}}
}

// SetClock replaces the time source (tests).
func (a *Agent) SetClock(now func() time.Time) { a.now = now; a.store.SetClock(now) }

// Register adds every implemented method to srv.
func (a *Agent) Register(srv *rpc.Server) {
	srv.Handle("session.hello", a.hello)
	srv.Handle("auth.totpEnrolStart", a.totpEnrolStart)
	srv.Handle("auth.totpEnrolConfirm", a.totpEnrolConfirm)
	srv.Handle("auth.verifyDaily", a.verifyDaily)
	srv.Handle("auth.pinSet", a.pinSet)
	srv.Handle("auth.verifyPin", a.verifyPin)
	srv.Handle("auth.stepUp", a.stepUp)
	srv.Handle("lock.get", a.lockGet)
	srv.Handle("lock.set", a.lockSet)
	srv.Handle("gateway.lease", a.gatewayLease)
	srv.Handle("gateway.release", a.gatewayRelease)
	srv.Handle("audit.append", a.auditAppend)
	srv.Handle("policy.get", a.policyGet)
	srv.Handle("telegram.linkStart", a.telegramLinkStart)
}

// ---- errors in plain words ----

var (
	errNotSignedUp = &rpc.Error{Code: rpc.CodeUnauthorized, Message: "This Windows account isn't set up for Off Manual yet. Sign in to get started, or ask your admin to add you."}
	errDisabled    = &rpc.Error{Code: rpc.CodeUnauthorized, Message: "Your Off Manual access is switched off. Please contact your admin."}
	errNotEnrolled = &rpc.Error{Code: rpc.CodeConflict, Message: "Set up your authenticator app first."}
	errLocked      = &rpc.Error{Code: rpc.CodeLocked, Message: "Off Manual is locked. Unlock it with your PIN or today's code."}
)

func lockedOut(until time.Time) *rpc.Error {
	return &rpc.Error{Code: rpc.CodeLocked,
		Message: fmt.Sprintf("Too many wrong codes. Try again after %s, or ask your admin.", until.In(IST).Format("15:04")),
		Data:    map[string]any{"lockedUntil": until.UTC().Format(time.RFC3339)}}
}

// ---- helpers ----

func (a *Agent) employee(ctx context.Context, c rpc.Caller, allowInvited bool) (store.Employee, error) {
	if c.SID == "" {
		return store.Employee{}, errNotSignedUp
	}
	e, err := a.store.Employee(ctx, c.SID)
	if errors.Is(err, store.ErrNotFound) {
		return store.Employee{}, errNotSignedUp
	}
	if err != nil {
		return store.Employee{}, err
	}
	switch e.Status {
	case "active":
		return e, nil
	case "invited":
		if allowInvited {
			return e, nil
		}
		return store.Employee{}, errNotSignedUp
	default:
		return store.Employee{}, errDisabled
	}
}

func (a *Agent) attempts(ctx context.Context, sid string) (store.LockState, auth.Attempts, error) {
	l, err := a.store.Lock(ctx, sid)
	if err != nil {
		return l, auth.Attempts{}, err
	}
	return l, auth.Attempts{FailedPINs: l.FailedPINs, FailedCodes: l.FailedCodes, LockoutUntil: l.LockoutUntil}, nil
}

func (a *Agent) saveAttempts(ctx context.Context, sid string, l store.LockState, at auth.Attempts) error {
	l.FailedPINs, l.FailedCodes, l.LockoutUntil = at.FailedPINs, at.FailedCodes, at.LockoutUntil
	return a.store.SaveLock(ctx, sid, l)
}

func (a *Agent) audit(ctx context.Context, sid, category, action, result string) {
	if err := a.store.AppendAudit(ctx, store.AuditEvent{SID: sid, Category: category, Action: action, Result: result}); err != nil {
		a.log.Error("audit append failed", "category", category, "error", err.Error())
	}
}

// dayEnd returns the next DayEndHourIST after now.
func (a *Agent) dayEnd(now time.Time) time.Time {
	n := now.In(IST)
	end := time.Date(n.Year(), n.Month(), n.Day(), a.cfg.DayEndHourIST, 0, 0, 0, IST)
	if !end.After(n) {
		end = end.AddDate(0, 0, 1)
	}
	return end
}

// checkCode verifies a TOTP code with lockout accounting. On success it advances
// replay protection and resets failure counters.
func (a *Agent) checkCode(ctx context.Context, e store.Employee, code, action string) error {
	now := a.now()
	l, at, err := a.attempts(ctx, e.SID)
	if err != nil {
		return err
	}
	if at.LockedOut(now) {
		return lockedOut(at.LockoutUntil)
	}
	if e.TOTPEnrolledAt.IsZero() || len(e.TOTPSecretDPAPI) == 0 {
		return errNotEnrolled
	}
	secret, err := a.secrets.Unprotect(e.TOTPSecretDPAPI)
	if err != nil {
		return fmt.Errorf("unprotect TOTP secret: %w", err)
	}
	counter, verr := auth.Verify(string(secret), code, now, e.TOTPLastCounter, auth.DefaultSkew, auth.Default())
	if verr != nil {
		out := at.CodeFailed(now)
		if err := a.saveAttempts(ctx, e.SID, l, at); err != nil {
			return err
		}
		a.audit(ctx, e.SID, "auth", action, "wrong_code")
		if out.AlertAdmin {
			a.audit(ctx, e.SID, "auth", "lockout", "locked_15m")
			return lockedOut(out.LockedUntil)
		}
		if errors.Is(verr, auth.ErrReplayed) {
			return &rpc.Error{Code: rpc.CodeWrongCode, Message: "That code was already used. Wait for the next code in your app and enter it."}
		}
		return &rpc.Error{Code: rpc.CodeWrongCode, Message: "That code isn't right. Check the time on your phone and enter the newest code.",
			Data: map[string]any{"remaining": auth.MaxCodeFailures - at.FailedCodes}}
	}
	if err := a.store.AdvanceTOTPCounter(ctx, e.SID, counter); err != nil {
		return err
	}
	at.CodeSucceeded()
	return a.saveAttempts(ctx, e.SID, l, at)
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// HashToken is how gateway tokens are stored (never the token itself).
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func rfc(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func decode(p json.RawMessage, dst any) error { return rpc.DecodeParams(p, dst) }
