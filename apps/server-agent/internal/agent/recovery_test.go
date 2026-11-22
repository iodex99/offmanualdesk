package agent

import (
	"context"
	"regexp"
	"testing"

	"offmanual/desk/server-agent/internal/rpc"
)

func TestRecoveryCodesShownOnceAndResetTheAuthenticator(t *testing.T) {
	e := newEnv(t)
	res := e.mustOK(asha, "auth.totpEnrolStart", map[string]string{"account": "x@firm.in"})
	confirm := e.mustOK(asha, "auth.totpEnrolConfirm", map[string]string{"code": e.totp(res["secret"].(string))})
	raw, _ := confirm["recoveryCodes"].([]any)
	if len(raw) != RecoveryCodeCount {
		t.Fatalf("codes %v", confirm)
	}
	format := regexp.MustCompile(`^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$`)
	seen := map[string]bool{}
	for _, c := range raw {
		s := c.(string)
		if !format.MatchString(s) || seen[s] {
			t.Fatalf("bad or repeated code %q", s)
		}
		seen[s] = true
	}
	first := raw[0].(string)
	// Only hashes are stored.
	if left, _ := e.st.RecoveryCodesLeft(context.Background(), asha.SID); left != RecoveryCodeCount {
		t.Fatalf("left %d", left)
	}

	if _, errObj := e.call(asha, "auth.recover", map[string]string{"code": "AAAAA-BBBBB"}); errObj == nil || errObj["code"] != float64(rpc.CodeWrongCode) {
		t.Fatalf("wrong code: %v", errObj)
	}
	// Lower case and no dash are accepted.
	lower := []byte(first[:5] + first[6:])
	for i, b := range lower {
		if b >= 'A' && b <= 'Z' {
			lower[i] = b + 32
		}
	}
	r := e.mustOK(asha, "auth.recover", map[string]string{"code": string(lower)})
	if r["reset"] != true || r["codesLeft"] != float64(RecoveryCodeCount-1) {
		t.Fatalf("recover: %v", r)
	}
	h := e.mustOK(asha, "session.hello", nil)
	if h["totpEnrolled"] != false || h["dayUnlocked"] != false {
		t.Fatalf("after recovery: %v", h)
	}
	if _, errObj := e.call(asha, "auth.recover", map[string]string{"code": first}); errObj == nil {
		t.Fatal("a used code worked twice")
	}
	// Re-enrolling a new phone works and issues fresh codes.
	res = e.mustOK(asha, "auth.totpEnrolStart", map[string]string{"account": "x@firm.in"})
	again := e.mustOK(asha, "auth.totpEnrolConfirm", map[string]string{"code": e.totp(res["secret"].(string))})
	if codes, _ := again["recoveryCodes"].([]any); len(codes) != RecoveryCodeCount {
		t.Fatalf("fresh codes %v", again)
	}
}

func TestRecoveryAttemptsAreLimited(t *testing.T) {
	e := newEnv(t)
	e.enrol(asha)
	for i := 0; i < recoverMaxAttempts; i++ {
		e.call(asha, "auth.recover", map[string]string{"code": "AAAAA-BBBBB"})
	}
	if _, errObj := e.call(asha, "auth.recover", map[string]string{"code": "AAAAA-BBBBB"}); errObj == nil || errObj["code"] != float64(rpc.CodeLocked) {
		t.Fatalf("limit: %v", errObj)
	}
	e.advance(recoverWindow + 1)
	if _, errObj := e.call(asha, "auth.recover", map[string]string{"code": "AAAAA-BBBBB"}); errObj == nil || errObj["code"] != float64(rpc.CodeWrongCode) {
		t.Fatalf("after window: %v", errObj)
	}
	if _, errObj := e.call(nobod, "auth.recover", map[string]string{"code": "AAAAA-BBBBB"}); errObj == nil || errObj["code"] != float64(rpc.CodeUnauthorized) {
		t.Fatalf("unknown caller: %v", errObj)
	}
}
