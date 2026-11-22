package agent

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"time"

	"offmanual/desk/server-agent/internal/rpc"
)

// UserMessage is an error whose text is a complete sentence shown to the employee.
type UserMessage string

func (m UserMessage) Error() string { return string(m) }

// MetaBotUsername holds the firm bot's @username (set by `server-agent telegram-setup`).
const MetaBotUsername = "telegram_bot_username"

const linkAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

func linkCode() (string, error) {
	b := make([]byte, 10)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	out := make([]byte, len(b))
	for i, x := range b {
		out[i] = linkAlphabet[int(x)%len(linkAlphabet)]
	}
	return string(out), nil
}

// telegramLinkStart returns a one-time deep link (F7 step 1): t.me/<bot>?start=<code>, 10 minutes.
func (a *Agent) telegramLinkStart(ctx context.Context, c rpc.Caller, p json.RawMessage) (any, error) {
	if err := decode(p, &struct{}{}); err != nil {
		return nil, err
	}
	e, err := a.employee(ctx, c, false)
	if err != nil {
		return nil, err
	}
	bot, err := a.store.Meta(ctx, MetaBotUsername)
	if err != nil || bot == "" {
		return nil, &rpc.Error{Code: rpc.CodeConflict, Message: "Telegram isn't set up for your firm yet. Ask your admin."}
	}
	if fp, ok := a.firmPolicy(ctx); ok && fp.TelegramMode == "off" {
		return nil, &rpc.Error{Code: rpc.CodeConflict, Message: "Telegram is switched off for your firm."}
	}
	code, err := linkCode()
	if err != nil {
		return nil, err
	}
	if err := a.store.CreateLinkCode(ctx, e.SID, code, 10*time.Minute); err != nil {
		return nil, err
	}
	a.audit(ctx, e.SID, "telegram", "link_start", "ok")
	return map[string]string{"url": "https://t.me/" + bot + "?start=" + code, "expiresInMinutes": "10"}, nil
}

// TelegramUnlock checks today's code for sid and opens a Telegram-only unlock window
// (ARCHITECTURE F8: /unlock 123456) for the firm's telegram_unlock_max_min (default 60).
// The returned error's text is shown to the employee.
func (a *Agent) TelegramUnlock(ctx context.Context, sid, code string) error {
	e, err := a.employee(ctx, rpc.Caller{SID: sid}, false)
	if err != nil {
		return UserMessage("Your Off Manual access is switched off. Please contact your admin.")
	}
	if err := a.checkCode(ctx, e, code, "telegram_unlock"); err != nil {
		var re *rpc.Error
		if errors.As(err, &re) {
			return UserMessage(re.Message)
		}
		return UserMessage("Off Manual couldn't check that code. Try again.")
	}
	window := 60 * time.Minute
	if raw, err := a.store.Meta(ctx, "policy_json"); err == nil {
		var doc struct {
			Policy struct {
				TelegramUnlockMaxMin int `json:"telegramUnlockMaxMin"`
			} `json:"policy"`
		}
		if json.Unmarshal([]byte(raw), &doc) == nil && doc.Policy.TelegramUnlockMaxMin > 0 {
			window = time.Duration(doc.Policy.TelegramUnlockMaxMin) * time.Minute
		}
	}
	l, err := a.store.Lock(ctx, sid)
	if err != nil {
		return UserMessage("Off Manual couldn't unlock just now. Try again.")
	}
	l.TelegramUnlockedUntil = a.now().Add(window)
	if err := a.store.SaveLock(ctx, sid, l); err != nil {
		return UserMessage("Off Manual couldn't unlock just now. Try again.")
	}
	return nil
}

// ActiveEmployee reports whether sid is an active employee (Telegram router hook).
func (a *Agent) ActiveEmployee(ctx context.Context, sid string) bool {
	_, err := a.employee(ctx, rpc.Caller{SID: sid}, false)
	return err == nil
}

// TelegramMode returns the synced firm Telegram mode; "off" until a policy has synced.
func (a *Agent) TelegramMode(ctx context.Context) string {
	if fp, ok := a.firmPolicy(ctx); ok {
		return fp.TelegramMode
	}
	return "off"
}
