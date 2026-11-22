package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"offmanual/desk/server-agent/internal/store"
)

const asha = "S-1-5-21-1-2-3-1101"

type sent struct {
	mu   sync.Mutex
	msgs []string
}

func (s *sent) SendMessage(_ context.Context, _ int64, text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.msgs = append(s.msgs, text)
	return nil
}

func (s *sent) last() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.msgs) == 0 {
		return ""
	}
	return s.msgs[len(s.msgs)-1]
}

type env struct {
	st      *store.Store
	out     *sent
	r       *Router
	mode    string
	relay   func(text string) (string, error)
	unlockE error
	paused  string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	_ = st.UpsertEmployee(context.Background(), store.Employee{SID: asha, EmployeeID: "e1", Name: "Asha", Status: "active"})
	e := &env{st: st, out: &sent{}, mode: "text", relay: func(string) (string, error) { return "42 clients are pending.", nil }}
	e.r = &Router{Store: st, Send: e.out, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Hooks: Hooks{
		Mode:   func(context.Context) string { return e.mode },
		Relay:  func(_ context.Context, _ string, _ int64, text string) (string, error) { return e.relay(text) },
		Unlock: func(context.Context, string, string) error { return e.unlockE },
		Active: func(_ context.Context, sid string) bool { return sid == asha },
		Paused: func(context.Context) string { return e.paused },
	}}
	return e
}

func msg(from int64, text string) Update {
	return Update{UpdateID: 1, Message: &Message{From: &User{ID: from}, Chat: Chat{ID: from, Type: "private"}, Text: text}}
}

func (e *env) link(t *testing.T, tgUser int64) {
	t.Helper()
	if err := e.st.CreateLinkCode(context.Background(), asha, "ABCD2345", 10*time.Minute); err != nil {
		t.Fatal(err)
	}
	e.r.Handle(context.Background(), msg(tgUser, "/start ABCD2345"))
	if e.out.last() != MsgLinked {
		t.Fatalf("link reply %q", e.out.last())
	}
}

func TestLinkingIsOneTime(t *testing.T) {
	e := newEnv(t)
	e.link(t, 777)
	if sid, _ := e.st.SIDForTelegramUser(context.Background(), 777); sid != asha {
		t.Fatalf("linked sid %q", sid)
	}
	e.r.Handle(context.Background(), msg(888, "/start ABCD2345"))
	if e.out.last() != MsgLinkExpired {
		t.Fatalf("code reuse: %q", e.out.last())
	}
	e.r.Handle(context.Background(), msg(888, "/start"))
	if e.out.last() != MsgStart {
		t.Fatalf("bare start: %q", e.out.last())
	}
}

func TestExpiredCode(t *testing.T) {
	e := newEnv(t)
	_ = e.st.CreateLinkCode(context.Background(), asha, "OLDCODE1", -time.Minute)
	e.r.Handle(context.Background(), msg(777, "/start OLDCODE1"))
	if e.out.last() != MsgLinkExpired {
		t.Fatalf("expired: %q", e.out.last())
	}
}

func TestUnlinkedAndInactive(t *testing.T) {
	e := newEnv(t)
	e.r.Handle(context.Background(), msg(999, "hello"))
	if e.out.last() != MsgNotLinked {
		t.Fatalf("unlinked: %q", e.out.last())
	}
	e.link(t, 777)
	_ = e.st.DisableEmployee(context.Background(), asha) // offboarding also unlinks
	e.r.Handle(context.Background(), msg(777, "hello"))
	if e.out.last() != MsgNotLinked {
		t.Fatalf("after offboarding: %q", e.out.last())
	}
}

func TestPolicyModesAndFiles(t *testing.T) {
	e := newEnv(t)
	e.link(t, 777)
	e.mode = "off"
	e.r.Handle(context.Background(), msg(777, "hi"))
	if e.out.last() != MsgOff {
		t.Fatalf("off: %q", e.out.last())
	}
	e.mode = "text"
	doc := msg(777, "")
	doc.Message.Document = json.RawMessage(`{"file_id":"x"}`)
	e.r.Handle(context.Background(), doc)
	if e.out.last() != MsgNoFiles {
		t.Fatalf("file in text mode: %q", e.out.last())
	}
}

func TestRelayAnswersAndChunks(t *testing.T) {
	e := newEnv(t)
	e.link(t, 777)
	e.r.Handle(context.Background(), msg(777, "Which clients are pending?"))
	if e.out.last() != "42 clients are pending." {
		t.Fatalf("relay: %q", e.out.last())
	}
	e.relay = func(string) (string, error) { return strings.Repeat("a", 5000), nil }
	before := len(e.out.msgs)
	e.r.Handle(context.Background(), msg(777, "long please"))
	if got := len(e.out.msgs) - before; got != 2 {
		t.Fatalf("long answer sent in %d parts, want 2", got)
	}
	e.relay = func(string) (string, error) { return "", ErrNotRunning }
	e.r.Handle(context.Background(), msg(777, "hi"))
	if e.out.last() != MsgNotRunning {
		t.Fatalf("not running: %q", e.out.last())
	}
	e.relay = func(string) (string, error) { return "", errors.New("boom") }
	e.r.Handle(context.Background(), msg(777, "hi"))
	if e.out.last() != MsgBusyError {
		t.Fatalf("error: %q", e.out.last())
	}
}

func TestUnlockCommand(t *testing.T) {
	e := newEnv(t)
	e.link(t, 777)
	e.r.Handle(context.Background(), msg(777, "/unlock"))
	if e.out.last() != MsgUnlockUsage {
		t.Fatalf("usage: %q", e.out.last())
	}
	e.r.Handle(context.Background(), msg(777, "/unlock 123456"))
	if e.out.last() != MsgUnlocked {
		t.Fatalf("unlock: %q", e.out.last())
	}
	e.unlockE = errors.New("That code isn't right.")
	e.r.Handle(context.Background(), msg(777, "/unlock 000000"))
	if e.out.last() != "That code isn't right." {
		t.Fatalf("bad code: %q", e.out.last())
	}
}

func TestIgnoresGroupsAndBots(t *testing.T) {
	e := newEnv(t)
	group := msg(777, "hi")
	group.Message.Chat.Type = "group"
	e.r.Handle(context.Background(), group)
	bot := msg(777, "hi")
	bot.Message.From.IsBot = true
	e.r.Handle(context.Background(), bot)
	e.r.Handle(context.Background(), Update{UpdateID: 3})
	if len(e.out.msgs) != 0 {
		t.Fatalf("replied to %v", e.out.msgs)
	}
}

type fakePoller struct {
	calls  int
	cancel context.CancelFunc
}

func (p *fakePoller) GetUpdates(_ context.Context, offset int64, _ int) ([]Update, error) {
	p.calls++
	switch p.calls {
	case 1:
		return nil, errors.New("network blip")
	case 2:
		u := msg(999, "hello")
		u.UpdateID = 41
		return []Update{u}, nil
	default:
		p.cancel()
		return nil, context.Canceled
	}
}

func TestRunPersistsOffset(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithCancel(context.Background())
	p := &fakePoller{cancel: cancel}
	done := make(chan struct{})
	go func() { e.r.Run(ctx, p); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not stop")
	}
	if v, _ := e.st.Meta(context.Background(), "telegram_offset"); v != "42" {
		t.Fatalf("offset %q", v)
	}
}

func TestBotClient(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		switch {
		case strings.HasSuffix(r.URL.Path, "/getUpdates"):
			_, _ = w.Write([]byte(`{"ok":true,"result":[{"update_id":5,"message":{"message_id":1,"from":{"id":7,"is_bot":false},"chat":{"id":7,"type":"private"},"text":"hi"}}]}`))
		case strings.HasSuffix(r.URL.Path, "/sendMessage"):
			_, _ = w.Write([]byte(`{"ok":false,"description":"Forbidden: bot was blocked by the user"}`))
		}
	}))
	defer srv.Close()
	b := &Bot{BaseURL: srv.URL + "/botSECRET-TOKEN", HTTP: srv.Client()}
	ups, err := b.GetUpdates(context.Background(), 5, 1)
	if err != nil || len(ups) != 1 || ups[0].Message.Text != "hi" || got["offset"].(float64) != 5 {
		t.Fatalf("getUpdates: %+v %v %v", ups, err, got)
	}
	err = b.SendMessage(context.Background(), 7, "x")
	if err == nil || !strings.Contains(err.Error(), "blocked") || strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("sendMessage error %v", err)
	}
	dead := &Bot{BaseURL: "http://127.0.0.1:1/botSECRET-TOKEN", HTTP: &http.Client{Timeout: time.Second}}
	if err := dead.SendMessage(context.Background(), 1, "x"); err == nil || strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("transport error leaked the token: %v", err)
	}
}

func TestChunks(t *testing.T) {
	if c := Chunks("short"); len(c) != 1 || c[0] != "short" {
		t.Fatal(c)
	}
	long := strings.Repeat("x", 3000) + "\n" + strings.Repeat("y", 3000)
	c := Chunks(long)
	if len(c) != 2 || !strings.HasSuffix(c[0], "\n") || len([]rune(c[0])) > MaxMessageLen {
		t.Fatalf("split %d parts", len(c))
	}
	if len(Chunks("")) != 1 {
		t.Fatal("empty text must still produce one part")
	}
	multi := strings.Repeat("₹", 5000) // multi-byte runes never split mid-character
	for _, p := range Chunks(multi) {
		if !strings.HasPrefix(p, "₹") {
			t.Fatal("split inside a rune")
		}
	}
}

func TestPausedLicenceRepliesPlainly(t *testing.T) {
	e := newEnv(t)
	e.link(t, 777)
	e.paused = "Off Manual is paused for your firm. Please contact your admin."
	relayed := false
	e.relay = func(string) (string, error) { relayed = true; return "x", nil }
	e.r.Handle(context.Background(), msg(777, "hi"))
	if e.out.last() != e.paused || relayed {
		t.Fatalf("paused: %q relayed=%v", e.out.last(), relayed)
	}
	e.paused = ""
	e.r.Handle(context.Background(), msg(777, "hi"))
	if !relayed {
		t.Fatal("not relayed after the pause ended")
	}
}
