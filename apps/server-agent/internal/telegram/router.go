package telegram

import (
	"context"
	"errors"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"time"

	"offmanual/desk/server-agent/internal/store"
)

// Plain-language replies (PRODUCT.md §4: every "no" has a next step).
const (
	MsgNotLinked     = "This Telegram account isn't linked to Off Manual. Open Off Manual Desk, choose \"Link Telegram\" and follow the link."
	MsgLinked        = "Done. This Telegram account is now linked to Off Manual. Send me a question any time you're signed in to Desk."
	MsgLinkExpired   = "That link has expired or was already used. Open Off Manual Desk and choose \"Link Telegram\" again."
	MsgStart         = "To use Off Manual here, open Off Manual Desk and choose \"Link Telegram\"."
	MsgOff           = "Off Manual on Telegram is switched off for your firm. Please use Off Manual Desk."
	MsgNoFiles       = "Files can't be sent to Off Manual on Telegram. Save the file in the client's folder and ask about it here or in Desk."
	MsgNotRunning    = "Open Off Manual Desk on your work computer, then send your message again."
	MsgBusyError     = "Off Manual couldn't answer just now. Please try again in a minute."
	MsgUnlocked      = "Unlocked for Telegram. You can send questions now."
	MsgUnlockUsage   = "Send /unlock followed by today's 6-digit code from your authenticator app, e.g. /unlock 123456"
	MsgLinkStartHelp = "This link isn't valid. Open Off Manual Desk and choose \"Link Telegram\"."
)

// ErrNotRunning means the employee's assistant isn't running (no lease; ADR-026).
var ErrNotRunning = errors.New("assistant not running")

// Hooks connect the router to the rest of the agent.
type Hooks struct {
	// Mode returns the firm's Telegram mode: "off", "text" or "files".
	Mode func(ctx context.Context) string
	// Relay sends text to the employee's assistant and returns the reply.
	Relay func(ctx context.Context, sid string, telegramUserID int64, text string) (string, error)
	// Unlock verifies a TOTP code for sid and opens the Telegram window; returns a plain error message on failure.
	Unlock func(ctx context.Context, sid, code string) error
	// Active reports whether sid is an active employee.
	Active func(ctx context.Context, sid string) bool
	// Paused returns a plain message when the firm's licence stops employees (BILLING §6), else "".
	Paused func(ctx context.Context) string
	// Decide handles Approve/Deny for a Desk unlock request (ADR-068) and returns a plain message.
	Decide func(ctx context.Context, telegramUserID int64, requestID string, approve bool) string
}

// Sender is the part of Bot the router uses (a fake in tests).
type Sender interface {
	SendMessage(ctx context.Context, chatID int64, text string) error
	AnswerCallback(ctx context.Context, callbackID, text string) error
	EditMessageText(ctx context.Context, chatID, messageID int64, text string) error
}

// Router handles updates.
type Router struct {
	Store *store.Store
	Send  Sender
	Hooks Hooks
	Log   *slog.Logger
}

var (
	startRe  = regexp.MustCompile(`^/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{6,64}))?\s*$`)
	unlockRe = regexp.MustCompile(`^/unlock(?:@\w+)?(?:\s+(\d{6}))?\s*$`)
	// Approve/Deny buttons for a Desk unlock request (ADR-068).
	decisionRe = regexp.MustCompile(`^u([ad]):([0-9a-f]{32})$`)
)

// Handle processes one update. Message text is never logged (SECURITY §4).
func (r *Router) Handle(ctx context.Context, u Update) {
	if u.CallbackQuery != nil {
		r.handleCallback(ctx, u.CallbackQuery)
		return
	}
	m := u.Message
	if m == nil || m.From == nil || m.From.IsBot || m.Chat.Type != "private" {
		return // groups and channels are ignored: employees talk to the bot one to one
	}
	reply := func(text string) {
		for _, part := range Chunks(text) {
			if err := r.Send.SendMessage(ctx, m.Chat.ID, part); err != nil {
				r.Log.Warn("telegram send failed", "error", err.Error())
				return
			}
		}
	}
	text := strings.TrimSpace(m.Text)

	if sm := startRe.FindStringSubmatch(text); sm != nil {
		if sm[1] == "" {
			reply(MsgStart)
			return
		}
		if _, err := r.Store.ConsumeLinkCode(ctx, sm[1], m.From.ID); err != nil {
			reply(MsgLinkExpired)
			return
		}
		r.audit(ctx, m.From.ID, "link", "ok")
		reply(MsgLinked)
		return
	}

	sid, err := r.Store.SIDForTelegramUser(ctx, m.From.ID)
	if err != nil || (r.Hooks.Active != nil && !r.Hooks.Active(ctx, sid)) {
		reply(MsgNotLinked)
		return
	}
	if r.Hooks.Paused != nil {
		if msg := r.Hooks.Paused(ctx); msg != "" {
			reply(msg)
			return
		}
	}
	mode := "off"
	if r.Hooks.Mode != nil {
		mode = r.Hooks.Mode(ctx)
	}
	if mode == "off" {
		reply(MsgOff)
		return
	}
	if (len(m.Document) > 0 || len(m.Photo) > 0) && mode != "files" {
		reply(MsgNoFiles)
		return
	}

	if um := unlockRe.FindStringSubmatch(text); um != nil {
		if um[1] == "" {
			reply(MsgUnlockUsage)
			return
		}
		if err := r.Hooks.Unlock(ctx, sid, um[1]); err != nil {
			reply(err.Error())
			return
		}
		reply(MsgUnlocked)
		return
	}
	if text == "" {
		reply(MsgNoFiles)
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	answer, err := r.Hooks.Relay(ctx, sid, m.From.ID, text)
	switch {
	case errors.Is(err, ErrNotRunning):
		reply(MsgNotRunning)
	case err != nil:
		r.Log.Warn("telegram relay failed", "error", err.Error())
		reply(MsgBusyError)
	case strings.TrimSpace(answer) == "":
		reply(MsgBusyError)
	default:
		clean, changed := SanitizeReply(answer)
		if changed {
			r.audit(ctx, m.From.ID, "message", "sanitized")
		}
		r.audit(ctx, m.From.ID, "message", "answered")
		reply(clean)
	}
}

func (r *Router) audit(ctx context.Context, tgUser int64, action, result string) {
	sid, _ := r.Store.SIDForTelegramUser(ctx, tgUser)
	if sid == "" {
		return
	}
	_ = r.Store.AppendAudit(ctx, store.AuditEvent{SID: sid, Category: "telegram", Action: action, Result: result})
}

// Poller is the getUpdates side (a fake in tests).
type Poller interface {
	GetUpdates(ctx context.Context, offset int64, timeoutSec int) ([]Update, error)
}

// Run long-polls until ctx ends, persisting the update offset in meta so a restart
// never replays messages.
func (r *Router) Run(ctx context.Context, p Poller) {
	offset := int64(0)
	if v, err := r.Store.Meta(ctx, "telegram_offset"); err == nil {
		offset, _ = strconv.ParseInt(v, 10, 64)
	}
	backoff := time.Second
	for ctx.Err() == nil {
		ups, err := p.GetUpdates(ctx, offset, 50)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			r.Log.Warn("telegram poll failed", "error", err.Error())
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff < time.Minute {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
		for _, u := range ups {
			r.Handle(ctx, u)
			offset = u.UpdateID + 1
			_ = r.Store.SetMeta(ctx, "telegram_offset", FormatOffset(offset))
		}
	}
}

// handleCallback answers an Approve/Deny tap. Only the employee's linked Telegram
// account can approve (the agent checks the link and every unlock rule again).
func (r *Router) handleCallback(ctx context.Context, q *CallbackQuery) {
	if q.From == nil || q.From.IsBot || q.ID == "" {
		return
	}
	msg := "This button doesn't do anything any more."
	if m := decisionRe.FindStringSubmatch(q.Data); m != nil && r.Hooks.Decide != nil {
		msg = r.Hooks.Decide(ctx, q.From.ID, m[2], m[1] == "a")
	}
	if err := r.Send.AnswerCallback(ctx, q.ID, msg); err != nil {
		r.Log.Warn("telegram answer failed", "error", err.Error())
	}
	if q.Message != nil && q.Message.Chat.Type == "private" {
		if err := r.Send.EditMessageText(ctx, q.Message.Chat.ID, q.Message.MessageID, msg); err != nil {
			r.Log.Warn("telegram edit failed", "error", err.Error())
		}
	}
}
