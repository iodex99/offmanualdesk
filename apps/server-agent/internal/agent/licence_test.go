package agent

import (
	"context"
	"testing"
	"time"
)

func TestLicence(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	set := func(status string, contact time.Time) {
		_ = e.st.SetMeta(ctx, metaFirmStatus, status)
		_ = e.st.SetMeta(ctx, metaLastContact, contact.UTC().Format(time.RFC3339))
	}
	if l := e.ag.Licence(ctx); l.Usable || l.Reason != "not_activated" || l.Message != MsgNotActivated {
		t.Fatalf("never synced: %+v", l)
	}
	cases := []struct {
		status  string
		ago     time.Duration
		usable  bool
		reason  string
		notice  string
		message string
	}{
		{"active", time.Hour, true, "ok", "", ""},
		{"trial", time.Hour, true, "ok", "", ""},
		{"overdue", time.Hour, true, "ok", NoticeOverdue, ""},
		{"restricted", time.Hour, true, "ok", NoticeOverdue, ""},
		{"suspended", time.Hour, false, "paused", "", MsgPaused},
		{"closed", time.Hour, false, "paused", "", MsgPaused},
		{"something-new", time.Hour, false, "unknown", "", MsgPaused},
		{"active", OfflineGrace - time.Minute, true, "ok", "", ""},
		{"active", OfflineGrace + time.Minute, false, "offline", "", MsgOffline},
	}
	for _, c := range cases {
		set(c.status, e.clock.Add(-c.ago))
		l := e.ag.Licence(ctx)
		if l.Usable != c.usable || l.Reason != c.reason || l.Notice != c.notice || l.Message != c.message {
			t.Fatalf("%s %v ago: %+v", c.status, c.ago, l)
		}
		if got := e.ag.PausedMessage(ctx); got != c.message {
			t.Fatalf("PausedMessage %q", got)
		}
	}
	_ = e.st.SetMeta(ctx, metaLastContact, "not a time")
	if l := e.ag.Licence(ctx); l.Usable {
		t.Fatal("unparseable contact time must fail closed")
	}
}

func TestLockGetCarriesLicence(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_ = e.st.SetMeta(ctx, metaFirmStatus, "suspended")
	_ = e.st.SetMeta(ctx, metaLastContact, e.clock.Format(time.RFC3339))
	st := e.mustOK(asha, "lock.get", nil)
	if st["servicePaused"] != true || st["pausedMessage"] != MsgPaused {
		t.Fatalf("suspended: %v", st)
	}
	_ = e.st.SetMeta(ctx, metaFirmStatus, "overdue")
	st = e.mustOK(asha, "lock.get", nil)
	if _, ok := st["servicePaused"]; ok || st["notice"] != NoticeOverdue {
		t.Fatalf("overdue: %v", st)
	}
}
