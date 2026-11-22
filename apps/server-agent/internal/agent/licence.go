package agent

import (
	"context"
	"time"
)

// Meta keys written by the console Syncer (internal/console/sync.go). Repeated here
// to keep agent independent of the console package.
const (
	metaFirmStatus  = "firm_status"
	metaLastContact = "last_console_contact_at"
)

// OfflineGrace is how long the licence keeps working without console contact
// (docs/BILLING.md §6 offline rule, default 7 days).
const OfflineGrace = 7 * 24 * time.Hour

// Licence is what employees may do given the firm's billing state (BILLING §6).
type Licence struct {
	Usable bool
	// Reason is a stable code: ok, not_activated, paused, offline, unknown.
	Reason string
	// Message is the plain sentence shown when !Usable.
	Message string
	// Notice is an optional banner when usable (overdue / restricted).
	Notice string
}

// Plain messages (PRODUCT.md ease rules).
const (
	MsgNotActivated = "Off Manual isn't activated on this server yet. Please tell your admin."
	MsgPaused       = "Off Manual is paused for your firm. Please contact your admin."
	MsgOffline      = "Off Manual hasn't been able to reach Off Manual's servers for over a week, so it's paused. Please tell your admin."
	NoticeOverdue   = "Your firm's Off Manual bill is overdue. Your admin has been told."
)

// Licence derives the licence from the synced firm status and the last console
// contact. Unknown states fail closed.
func (a *Agent) Licence(ctx context.Context) Licence {
	status, err := a.store.Meta(ctx, metaFirmStatus)
	if err != nil || status == "" {
		return Licence{Reason: "not_activated", Message: MsgNotActivated}
	}
	last, err := a.store.Meta(ctx, metaLastContact)
	if err != nil {
		return Licence{Reason: "not_activated", Message: MsgNotActivated}
	}
	t, err := time.Parse(time.RFC3339, last)
	if err != nil {
		return Licence{Reason: "unknown", Message: MsgPaused}
	}
	if a.now().Sub(t) > OfflineGrace {
		return Licence{Reason: "offline", Message: MsgOffline}
	}
	switch status {
	case "trial", "active":
		return Licence{Usable: true, Reason: "ok"}
	case "overdue", "restricted":
		return Licence{Usable: true, Reason: "ok", Notice: NoticeOverdue}
	case "suspended", "closed":
		return Licence{Reason: "paused", Message: MsgPaused}
	default:
		return Licence{Reason: "unknown", Message: MsgPaused}
	}
}

// PausedMessage returns the plain message when the licence stops employees, else "".
// (Telegram router hook.)
func (a *Agent) PausedMessage(ctx context.Context) string {
	if l := a.Licence(ctx); !l.Usable {
		return l.Message
	}
	return ""
}
