package auth

import "time"

// Lockout rules from docs/ARCHITECTURE.md F3:
//   - 3 wrong PINs → the PIN no longer works; the daily code is needed.
//   - 5 wrong codes → 15-minute lockout and an alert to the firm admin.
//   - Any success resets the counters it covers.
const (
	MaxPINFailures  = 3
	MaxCodeFailures = 5
	LockoutDuration = 15 * time.Minute
)

// Attempts is the per-employee counter state persisted in agent.db `lock_state`.
type Attempts struct {
	FailedPINs   int
	FailedCodes  int
	LockoutUntil time.Time
}

// Outcome tells the caller what to show and whether to alert the admin.
type Outcome struct {
	NeedDailyCode bool      // PIN disabled until a daily code is entered
	LockedUntil   time.Time // zero unless locked out
	AlertAdmin    bool      // raise an admin notice + audit event (once per lockout)
}

// LockedOut reports whether any verification must be refused at now.
func (a Attempts) LockedOut(now time.Time) bool { return now.Before(a.LockoutUntil) }

// PINAllowed reports whether a PIN may be tried at now.
func (a Attempts) PINAllowed(now time.Time) bool {
	return !a.LockedOut(now) && a.FailedPINs < MaxPINFailures
}

// PINFailed records a wrong PIN.
func (a *Attempts) PINFailed(now time.Time) Outcome {
	a.FailedPINs++
	return Outcome{NeedDailyCode: a.FailedPINs >= MaxPINFailures, LockedUntil: a.lockedUntil(now)}
}

// PINSucceeded resets the PIN counter.
func (a *Attempts) PINSucceeded() { a.FailedPINs = 0 }

// CodeFailed records a wrong TOTP code (daily, step-up or Telegram unlock).
func (a *Attempts) CodeFailed(now time.Time) Outcome {
	if a.LockedOut(now) {
		return Outcome{NeedDailyCode: true, LockedUntil: a.LockoutUntil}
	}
	a.FailedCodes++
	if a.FailedCodes >= MaxCodeFailures {
		a.LockoutUntil = now.Add(LockoutDuration)
		a.FailedCodes = 0
		return Outcome{NeedDailyCode: true, LockedUntil: a.LockoutUntil, AlertAdmin: true}
	}
	return Outcome{NeedDailyCode: a.FailedPINs >= MaxPINFailures}
}

// CodeSucceeded resets everything: a correct daily code re-enables the PIN.
func (a *Attempts) CodeSucceeded() {
	a.FailedCodes = 0
	a.FailedPINs = 0
}

func (a Attempts) lockedUntil(now time.Time) time.Time {
	if a.LockedOut(now) {
		return a.LockoutUntil
	}
	return time.Time{}
}
