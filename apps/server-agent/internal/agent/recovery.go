package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"offmanual/desk/server-agent/internal/rpc"
)

// Recovery codes (ARCHITECTURE F2 step 4, ADR-046): shown once when the
// authenticator is confirmed; one code resets the authenticator so a new phone can
// be enrolled. Each code has ~49 bits of entropy and tries are limited per SID.
const (
	RecoveryCodeCount   = 8
	recoverMaxAttempts  = 5
	recoverWindow       = time.Hour
	recoveryCodeLetters = 10
)

func normaliseRecovery(code string) string {
	return strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(code))
}

func hashRecovery(code string) string {
	sum := sha256.Sum256([]byte("om-recovery:" + normaliseRecovery(code)))
	return hex.EncodeToString(sum[:])
}

// newRecoveryCodes returns the codes to show (XXXXX-XXXXX) and their hashes to store.
func newRecoveryCodes() (codes, hashes []string, err error) {
	for i := 0; i < RecoveryCodeCount; i++ {
		raw, err := linkCode() // 10 characters, no look-alikes
		if err != nil {
			return nil, nil, err
		}
		c := raw[:5] + "-" + raw[5:recoveryCodeLetters]
		codes = append(codes, c)
		hashes = append(hashes, hashRecovery(c))
	}
	return codes, hashes, nil
}

// limited records an attempt for sid and reports whether the limit is exceeded.
func (a *Agent) limited(tries map[string][]time.Time, sid string, max int, window time.Duration) bool {
	now := a.now()
	recent := tries[sid][:0]
	for _, t := range tries[sid] {
		if now.Sub(t) < window {
			recent = append(recent, t)
		}
	}
	if len(recent) >= max {
		tries[sid] = recent
		return true
	}
	tries[sid] = append(recent, now)
	return false
}

// authRecover consumes a recovery code for the caller and resets their authenticator.
func (a *Agent) authRecover(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	var in struct {
		Code string `json:"code"`
	}
	if err := decode(p, &in); err != nil || len(in.Code) == 0 || len(in.Code) > 20 {
		return nil, rpc.Errorf(rpc.CodeInvalidParams, "invalid params")
	}
	e, err := a.employee(ctx, c, true)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	if a.recoverTries == nil {
		a.recoverTries = map[string][]time.Time{}
	}
	tooMany := a.limited(a.recoverTries, e.SID, recoverMaxAttempts, recoverWindow)
	a.mu.Unlock()
	if tooMany {
		return nil, &rpc.Error{Code: rpc.CodeLocked, Message: "Too many tries. Wait an hour, or ask your admin to reset your authenticator."}
	}
	ok, err := a.store.UseRecoveryCode(ctx, e.SID, hashRecovery(in.Code))
	if err != nil {
		return nil, err
	}
	if !ok {
		a.audit(ctx, e.SID, "auth", "recover", "wrong")
		return nil, &rpc.Error{Code: rpc.CodeWrongCode, Message: "That recovery code isn't right, or it was already used."}
	}
	// The day grant came from the old phone; the new one must be enrolled and used.
	if err := a.store.RevokeDay(ctx, e.SID); err != nil {
		return nil, err
	}
	left, _ := a.store.RecoveryCodesLeft(ctx, e.SID)
	a.audit(ctx, e.SID, "auth", "recover", "ok")
	return map[string]any{"reset": true, "codesLeft": left}, nil
}
