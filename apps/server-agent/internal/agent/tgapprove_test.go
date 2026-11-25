package agent

import (
	"context"
	"errors"
	"testing"
	"time"

	"offmanual/desk/server-agent/internal/rpc"
)

const ashaTG = int64(7001)

type prompts struct {
	to   []int64
	ids  []string
	text []string
	fail error
}

// approveEnv: Asha has today's authenticator unlock, a PIN, a linked Telegram
// account, Telegram on for the firm and a usable licence; Desk is locked after idle.
func approveEnv(t *testing.T) (*env, *prompts) {
	t.Helper()
	e := newEnv(t)
	e.st.SetClock(func() time.Time { return e.clock })
	ctx := context.Background()
	_ = e.st.SetMeta(ctx, "policy_json", `{"policy":{"telegramMode":"text"}}`)
	_ = e.st.SetMeta(ctx, metaFirmStatus, "active")
	_ = e.st.SetMeta(ctx, metaLastContact, e.clock.Format(time.RFC3339))
	secret := e.enrol(asha)
	e.advance(30 * time.Second) // each code works once (replay protection)
	e.mustOK(asha, "auth.pinSet", map[string]string{"pin": "4821", "code": e.totp(secret)})
	e.advance(30 * time.Second)
	_ = e.st.SetMeta(ctx, metaLastContact, e.clock.Format(time.RFC3339))
	e.mustOK(asha, "auth.verifyDaily", map[string]string{"code": e.totp(secret)})
	if err := e.st.CreateLinkCode(ctx, asha.SID, "ABCD2345", 10*time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := e.st.ConsumeLinkCode(ctx, "ABCD2345", ashaTG); err != nil {
		t.Fatal(err)
	}
	e.mustOK(asha, "lock.set", map[string]bool{"locked": true})
	p := &prompts{}
	e.ag.SetTelegramPrompter(func(_ context.Context, to int64, id, text string) error {
		if p.fail != nil {
			return p.fail
		}
		p.to, p.ids, p.text = append(p.to, to), append(p.ids, id), append(p.text, text)
		return nil
	})
	return e, p
}

func (e *env) deskLocked(t *testing.T) bool {
	t.Helper()
	l, err := e.st.Lock(context.Background(), asha.SID)
	if err != nil {
		t.Fatal(err)
	}
	return l.DeskLocked
}

func TestTelegramApproveUnlocksLikeAPIN(t *testing.T) {
	e, p := approveEnv(t)
	ctx := context.Background()
	if h := e.mustOK(asha, "session.hello", nil); h["telegramApprove"] != true {
		t.Fatalf("hello %v", h)
	}
	r := e.mustOK(asha, "unlock.telegramStart", nil)
	id := r["requestId"].(string)
	if len(p.to) != 1 || p.to[0] != ashaTG || p.ids[0] != id {
		t.Fatalf("prompt %+v", p)
	}
	if st := e.mustOK(asha, "unlock.telegramStatus", map[string]string{"requestId": id}); st["status"] != "pending" {
		t.Fatalf("status %v", st)
	}
	// Someone else's Telegram account can't approve.
	if msg := e.ag.TelegramDecision(ctx, 9999, id, true); msg == "Approved. Off Manual Desk is unlocked." || !e.deskLocked(t) {
		t.Fatal("approved by another Telegram account")
	}
	if msg := e.ag.TelegramDecision(ctx, ashaTG, id, true); msg != "Approved. Off Manual Desk is unlocked." {
		t.Fatalf("decision %q", msg)
	}
	if e.deskLocked(t) {
		t.Fatal("still locked after approve")
	}
	if st := e.mustOK(asha, "unlock.telegramStatus", map[string]string{"requestId": id}); st["status"] != "approved" {
		t.Fatalf("status %v", st)
	}
	// Single use.
	if msg := e.ag.TelegramDecision(ctx, ashaTG, id, true); msg != "This request has expired. Ask again from Off Manual Desk." {
		t.Fatalf("second tap %q", msg)
	}
	// Ravi can't read Asha's request.
	if st := e.mustOK(ravi, "unlock.telegramStatus", map[string]string{"requestId": id}); st["status"] != "expired" {
		t.Fatalf("other employee sees %v", st)
	}
}

func TestTelegramApproveDenyAndExpiry(t *testing.T) {
	e, _ := approveEnv(t)
	ctx := context.Background()
	id := e.mustOK(asha, "unlock.telegramStart", nil)["requestId"].(string)
	if msg := e.ag.TelegramDecision(ctx, ashaTG, id, false); msg != "Denied. Off Manual Desk stays locked." || !e.deskLocked(t) {
		t.Fatalf("deny %q", msg)
	}
	id2 := e.mustOK(asha, "unlock.telegramStart", nil)["requestId"].(string)
	e.advance(61 * time.Second)
	if st := e.mustOK(asha, "unlock.telegramStatus", map[string]string{"requestId": id2}); st["status"] != "expired" {
		t.Fatalf("status %v", st)
	}
	if msg := e.ag.TelegramDecision(ctx, ashaTG, id2, true); msg != "This request has expired. Ask again from Off Manual Desk." || !e.deskLocked(t) {
		t.Fatalf("late approve %q", msg)
	}
	// A newer request makes the older one unusable.
	old := e.mustOK(asha, "unlock.telegramStart", nil)["requestId"].(string)
	_ = e.mustOK(asha, "unlock.telegramStart", nil)
	if msg := e.ag.TelegramDecision(ctx, ashaTG, old, true); msg != "This request has expired. Ask again from Off Manual Desk." {
		t.Fatalf("older request approved: %q", msg)
	}
}

func TestTelegramApproveNeverReplacesTheDailyCode(t *testing.T) {
	ctx := context.Background()
	// No authenticator unlock today: not offered, refused.
	e, _ := approveEnv(t)
	e.advance(24 * time.Hour) // day grant expired
	if h := e.mustOK(asha, "session.hello", nil); h["telegramApprove"] != nil {
		t.Fatalf("offered without today's code: %v", h)
	}
	if _, errObj := e.call(asha, "unlock.telegramStart", nil); code(errObj) != rpc.CodeConflict {
		t.Fatalf("start without today's code: %v", errObj)
	}

	// Three wrong PINs: the daily code is required, so Telegram can't stand in.
	e2, _ := approveEnv(t)
	id := e2.mustOK(asha, "unlock.telegramStart", nil)["requestId"].(string)
	for i := 0; i < 3; i++ {
		_, _ = e2.call(asha, "auth.verifyPin", map[string]string{"pin": "000000"})
	}
	if msg := e2.ag.TelegramDecision(ctx, ashaTG, id, true); msg == "Approved. Off Manual Desk is unlocked." || !e2.deskLocked(t) {
		t.Fatalf("approved after PIN lockout: %q", msg)
	}
	if _, errObj := e2.call(asha, "unlock.telegramStart", nil); code(errObj) != rpc.CodeConflict {
		t.Fatal("start allowed after three wrong PINs")
	}

	// Firm switched Telegram off.
	e3, _ := approveEnv(t)
	_ = e3.st.SetMeta(ctx, "policy_json", `{"policy":{"telegramMode":"off"}}`)
	if _, errObj := e3.call(asha, "unlock.telegramStart", nil); code(errObj) != rpc.CodeConflict {
		t.Fatal("start allowed with Telegram off")
	}

	// Not linked.
	e4, _ := approveEnv(t)
	_ = e4.st.UnlinkTelegram(ctx, asha.SID)
	if _, errObj := e4.call(asha, "unlock.telegramStart", nil); code(errObj) != rpc.CodeConflict {
		t.Fatal("start allowed without a Telegram link")
	}

	// Switched off between request and tap.
	e5, _ := approveEnv(t)
	id5 := e5.mustOK(asha, "unlock.telegramStart", nil)["requestId"].(string)
	_ = e5.st.DisableEmployee(ctx, asha.SID)
	if msg := e5.ag.TelegramDecision(ctx, ashaTG, id5, true); msg == "Approved. Off Manual Desk is unlocked." {
		t.Fatal("approved for a switched-off employee")
	}
}

func TestTelegramApproveLimitsAndErrors(t *testing.T) {
	e, p := approveEnv(t)
	for i := 0; i < tgMaxPerHour; i++ {
		e.mustOK(asha, "unlock.telegramStart", nil)
	}
	if _, errObj := e.call(asha, "unlock.telegramStart", nil); code(errObj) != rpc.CodeConflict {
		t.Fatal("no hourly limit")
	}
	e2, p2 := approveEnv(t)
	p2.fail = errors.New("telegram down")
	if _, errObj := e2.call(asha, "unlock.telegramStart", nil); code(errObj) != rpc.CodeUnavailable {
		t.Fatalf("send failure: %v", errObj)
	}
	if _, errObj := e.call(asha, "unlock.telegramStatus", map[string]string{"requestId": "../x"}); code(errObj) != rpc.CodeInvalidParams {
		t.Fatal("bad request id accepted")
	}
	if _, errObj := e.call(asha, "unlock.telegramStart", map[string]string{"sid": ravi.SID}); code(errObj) != rpc.CodeInvalidParams {
		t.Fatal("extra field accepted")
	}
	_ = p
	// Not configured: nothing offered.
	e3 := newEnv(t)
	if e3.ag.TelegramApproveOffered(context.Background(), asha.SID) {
		t.Fatal("offered without a bot")
	}
}
