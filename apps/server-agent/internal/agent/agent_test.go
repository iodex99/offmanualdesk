package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"offmanual/desk/server-agent/internal/auth"
	"offmanual/desk/server-agent/internal/rpc"
	"offmanual/desk/server-agent/internal/secrets"
	"offmanual/desk/server-agent/internal/store"
)

var (
	asha  = rpc.Caller{SID: "S-1-5-21-100-200-300-1101", SessionID: 2, PID: 11}
	ravi  = rpc.Caller{SID: "S-1-5-21-100-200-300-1102", SessionID: 3, PID: 12}
	nobod = rpc.Caller{SID: "S-1-5-21-100-200-300-1999", SessionID: 4, PID: 13}
)

type env struct {
	t     *testing.T
	ag    *Agent
	st    *store.Store
	srv   *rpc.Server
	clock time.Time
}

func newEnv(t *testing.T) *env {
	t.Helper()
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	mem, _ := secrets.NewMemory()
	e := &env{t: t, st: st, srv: rpc.NewServer(nil), clock: time.Date(2026, 11, 23, 4, 0, 0, 0, time.UTC)} // 09:30 IST
	e.ag = New(st, mem, DefaultConfig(), nil)
	e.ag.SetClock(func() time.Time { return e.clock })
	e.ag.Register(e.srv)
	for _, c := range []rpc.Caller{asha, ravi} {
		if err := st.UpsertEmployee(context.Background(), store.Employee{SID: c.SID, EmployeeID: "emp-" + c.SID[len(c.SID)-4:], Name: "Employee " + c.SID[len(c.SID)-4:], Status: "active", Packs: []string{"core"}}); err != nil {
			t.Fatal(err)
		}
	}
	return e
}

func (e *env) advance(d time.Duration) { e.clock = e.clock.Add(d) }

// call runs one request as caller and returns (result, error object).
func (e *env) call(c rpc.Caller, method string, params any) (map[string]any, map[string]any) {
	e.t.Helper()
	srvConn, cli := net.Pipe()
	go func() { _ = e.srv.ServeConn(context.Background(), srvConn, c) }()
	defer func() { _ = cli.Close() }()
	p, _ := json.Marshal(params)
	if params == nil {
		p = []byte("{}")
	}
	_ = cli.SetDeadline(time.Now().Add(20 * time.Second))
	_, _ = fmt.Fprintf(cli, `{"jsonrpc":"2.0","id":1,"method":%q,"params":%s}`+"\n", method, p)
	line, err := bufio.NewReader(cli).ReadBytes('\n')
	if err != nil {
		e.t.Fatalf("%s: %v", method, err)
	}
	var resp struct {
		Result map[string]any `json:"result"`
		Error  map[string]any `json:"error"`
	}
	if err := json.Unmarshal(line, &resp); err != nil {
		e.t.Fatalf("%s: %v (%s)", method, err, line)
	}
	return resp.Result, resp.Error
}

func (e *env) mustOK(c rpc.Caller, method string, params any) map[string]any {
	e.t.Helper()
	res, errObj := e.call(c, method, params)
	if errObj != nil {
		e.t.Fatalf("%s failed: %v", method, errObj)
	}
	return res
}

func code(errObj map[string]any) int {
	if errObj == nil {
		return 0
	}
	return int(errObj["code"].(float64))
}

// enrol runs TOTP enrolment for c and returns the secret.
func (e *env) enrol(c rpc.Caller) string {
	e.t.Helper()
	res := e.mustOK(c, "auth.totpEnrolStart", map[string]string{"account": "x@firm.in"})
	secret := res["secret"].(string)
	if !strings.HasPrefix(res["uri"].(string), "otpauth://totp/") {
		e.t.Fatalf("bad uri %v", res["uri"])
	}
	e.mustOK(c, "auth.totpEnrolConfirm", map[string]string{"code": e.totp(secret)})
	return secret
}

func (e *env) totp(secret string) string {
	key, err := auth.DecodeSecret(secret)
	if err != nil {
		e.t.Fatal(err)
	}
	c, _ := auth.TOTP(key, e.clock, auth.Default())
	return c
}

func TestUnknownAndDisabledCallers(t *testing.T) {
	e := newEnv(t)
	res := e.mustOK(nobod, "session.hello", nil)
	if res["known"] != false || res["locked"] != true {
		t.Fatalf("unknown hello: %v", res)
	}
	for _, m := range []string{"lock.get", "gateway.lease", "policy.get"} {
		if _, errObj := e.call(nobod, m, nil); code(errObj) != rpc.CodeUnauthorized {
			t.Errorf("%s for unknown SID: %v", m, errObj)
		}
	}
	_ = e.st.UpsertEmployee(context.Background(), store.Employee{SID: ravi.SID, EmployeeID: "emp-1102", Name: "R", Status: "disabled"})
	_, errObj := e.call(ravi, "lock.get", nil)
	if code(errObj) != rpc.CodeUnauthorized || !strings.Contains(errObj["message"].(string), "switched off") {
		t.Fatalf("disabled: %v", errObj)
	}
}

func TestEnrolDailyUnlockAndReplay(t *testing.T) {
	e := newEnv(t)
	if res := e.mustOK(asha, "session.hello", nil); res["totpEnrolled"] != false || res["locked"] != true {
		t.Fatalf("before enrol: %v", res)
	}
	// Daily unlock before enrolment is refused.
	if _, errObj := e.call(asha, "auth.verifyDaily", map[string]string{"code": "123456"}); code(errObj) != rpc.CodeConflict {
		t.Fatalf("daily before enrol: %v", errObj)
	}
	secret := e.enrol(asha)
	if _, errObj := e.call(asha, "auth.totpEnrolStart", nil); code(errObj) != rpc.CodeConflict {
		t.Fatalf("re-enrol allowed: %v", errObj)
	}
	e.advance(30 * time.Second)
	c := e.totp(secret)
	res := e.mustOK(asha, "auth.verifyDaily", map[string]string{"code": c})
	until, _ := time.Parse(time.RFC3339, res["unlockedUntil"].(string))
	if want := time.Date(2026, 11, 23, 22, 0, 0, 0, IST); !until.Equal(want) {
		t.Fatalf("unlocked until %v, want %v", until, want)
	}
	if st := e.mustOK(asha, "lock.get", nil); st["locked"] != false || st["dayUnlocked"] != true {
		t.Fatalf("after unlock: %v", st)
	}
	// Same code again is a replay, even within the window.
	_, errObj := e.call(asha, "auth.verifyDaily", map[string]string{"code": c})
	if code(errObj) != rpc.CodeWrongCode || !strings.Contains(errObj["message"].(string), "already used") {
		t.Fatalf("replay: %v", errObj)
	}
	// Ravi is unaffected by Asha's unlock.
	if st := e.mustOK(ravi, "session.hello", nil); st["locked"] != true {
		t.Fatalf("other employee unlocked: %v", st)
	}
	// The day grant ends at 22:00 IST.
	e.clock = time.Date(2026, 11, 23, 22, 0, 1, 0, IST)
	if st := e.mustOK(asha, "lock.get", nil); st["locked"] != true {
		t.Fatalf("still unlocked after day end: %v", st)
	}
}

func TestPinFlowAndThreeStrikes(t *testing.T) {
	e := newEnv(t)
	secret := e.enrol(asha)
	e.advance(30 * time.Second)
	if _, errObj := e.call(asha, "auth.pinSet", map[string]string{"pin": "1234", "code": e.totp(secret)}); code(errObj) != rpc.CodeInvalidParams {
		t.Fatalf("weak PIN accepted: %v", errObj)
	}
	e.mustOK(asha, "auth.pinSet", map[string]string{"pin": "4821", "code": e.totp(secret)})
	e.advance(30 * time.Second)
	e.mustOK(asha, "auth.verifyDaily", map[string]string{"code": e.totp(secret)})

	e.mustOK(asha, "lock.set", map[string]bool{"locked": true})
	if st := e.mustOK(asha, "lock.get", nil); st["locked"] != true {
		t.Fatal("lock.set did not lock")
	}
	if _, errObj := e.call(asha, "lock.set", map[string]bool{"locked": false}); code(errObj) != rpc.CodeUnauthorized {
		t.Fatalf("unlock via lock.set allowed: %v", errObj)
	}
	e.mustOK(asha, "auth.verifyPin", map[string]string{"pin": "4821"})
	if st := e.mustOK(asha, "lock.get", nil); st["locked"] != false {
		t.Fatal("PIN did not unlock")
	}

	e.mustOK(asha, "lock.set", map[string]bool{"locked": true})
	for i := 1; i <= 2; i++ {
		_, errObj := e.call(asha, "auth.verifyPin", map[string]string{"pin": "0000"})
		if code(errObj) != rpc.CodeWrongCode {
			t.Fatalf("wrong PIN %d: %v", i, errObj)
		}
	}
	_, errObj := e.call(asha, "auth.verifyPin", map[string]string{"pin": "9999"})
	if code(errObj) != rpc.CodeLocked || errObj["data"].(map[string]any)["needDailyCode"] != true {
		t.Fatalf("3rd wrong PIN: %v", errObj)
	}
	// Even the right PIN is refused now; the daily code re-enables it.
	if _, errObj := e.call(asha, "auth.verifyPin", map[string]string{"pin": "4821"}); code(errObj) != rpc.CodeLocked {
		t.Fatalf("PIN after 3 strikes: %v", errObj)
	}
	e.advance(30 * time.Second)
	e.mustOK(asha, "auth.verifyDaily", map[string]string{"code": e.totp(secret)})
	e.mustOK(asha, "lock.set", map[string]bool{"locked": true})
	e.mustOK(asha, "auth.verifyPin", map[string]string{"pin": "4821"})
}

func TestFiveWrongCodesLockOut(t *testing.T) {
	e := newEnv(t)
	secret := e.enrol(asha)
	for i := 1; i <= 4; i++ {
		_, errObj := e.call(asha, "auth.verifyDaily", map[string]string{"code": "000000"})
		if code(errObj) != rpc.CodeWrongCode {
			t.Fatalf("attempt %d: %v", i, errObj)
		}
	}
	_, errObj := e.call(asha, "auth.verifyDaily", map[string]string{"code": "000000"})
	if code(errObj) != rpc.CodeLocked || errObj["data"].(map[string]any)["lockedUntil"] == nil {
		t.Fatalf("5th: %v", errObj)
	}
	e.advance(30 * time.Second)
	if _, errObj := e.call(asha, "auth.verifyDaily", map[string]string{"code": e.totp(secret)}); code(errObj) != rpc.CodeLocked {
		t.Fatalf("right code during lockout: %v", errObj)
	}
	e.advance(15 * time.Minute)
	e.mustOK(asha, "auth.verifyDaily", map[string]string{"code": e.totp(secret)})
	sum, _ := e.st.AuditSummary(context.Background(), e.clock.Add(-time.Hour), e.clock.Add(time.Hour))
	found := false
	for _, s := range sum {
		found = found || (s.Category == "auth" && s.Count >= 7)
	}
	if !found {
		t.Fatalf("auth events not audited: %+v", sum)
	}
}

func TestGatewayLeases(t *testing.T) {
	e := newEnv(t)
	if _, errObj := e.call(asha, "gateway.lease", nil); code(errObj) != rpc.CodeLocked {
		t.Fatalf("lease while locked: %v", errObj)
	}
	for _, c := range []rpc.Caller{asha, ravi} {
		s := e.enrol(c)
		e.advance(30 * time.Second)
		e.mustOK(c, "auth.verifyDaily", map[string]string{"code": e.totp(s)})
	}
	a := e.mustOK(asha, "gateway.lease", nil)
	r := e.mustOK(ravi, "gateway.lease", nil)
	if a["port"].(float64) != 18800 || r["port"].(float64) != 18801 {
		t.Fatalf("ports %v %v", a["port"], r["port"])
	}
	if p, ok := a["packs"].([]any); !ok || len(p) != 1 || p[0] != "core" {
		t.Fatalf("lease packs %v (ADR-069)", a["packs"])
	}
	tok := a["token"].(string)
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(tok) || tok == r["token"] {
		t.Fatalf("tokens %q %q", tok, r["token"])
	}
	l, _ := e.st.LeaseFor(context.Background(), asha.SID)
	if l.TokenHash == tok || l.TokenHash != HashToken(tok) {
		t.Fatal("token stored in clear or wrong hash")
	}
	// Re-lease keeps the port, rotates the token.
	a2 := e.mustOK(asha, "gateway.lease", nil)
	if a2["port"] != a["port"] || a2["token"] == tok {
		t.Fatalf("re-lease %v", a2)
	}
	e.mustOK(asha, "gateway.release", nil)
	if _, err := e.st.LeaseFor(context.Background(), asha.SID); err == nil {
		t.Fatal("lease not released")
	}
	// Ravi's release can't touch anyone else's lease (it only ever acts on the caller).
	e.mustOK(ravi, "gateway.release", nil)
}

func TestStepUpGrants(t *testing.T) {
	e := newEnv(t)
	secret := e.enrol(asha)
	e.advance(30 * time.Second)
	if _, errObj := e.call(asha, "auth.stepUp", map[string]string{"code": e.totp(secret), "action": "Bad Action!"}); code(errObj) != rpc.CodeInvalidParams {
		t.Fatalf("bad action: %v", errObj)
	}
	res := e.mustOK(asha, "auth.stepUp", map[string]string{"code": e.totp(secret), "action": "tally.post"})
	id := res["grantId"].(string)
	if !e.ag.StepUpValid(id, asha.SID, "tally.post") {
		t.Fatal("grant not valid")
	}
	if e.ag.StepUpValid(id, ravi.SID, "tally.post") || e.ag.StepUpValid(id, asha.SID, "email.send") {
		t.Fatal("grant valid for another employee or action")
	}
	// The guard's pipe check uses the caller's OS identity: Ravi can't use Asha's grant.
	if r := e.mustOK(asha, "auth.stepUpCheck", map[string]string{"grantId": id, "action": "tally.post"}); r["valid"] != true {
		t.Fatalf("check: %v", r)
	}
	if r := e.mustOK(ravi, "auth.stepUpCheck", map[string]string{"grantId": id, "action": "tally.post"}); r["valid"] != false {
		t.Fatalf("other employee: %v", r)
	}
	if _, errObj := e.call(asha, "auth.stepUpCheck", map[string]string{"grantId": id, "action": "Bad!"}); code(errObj) != rpc.CodeInvalidParams {
		t.Fatalf("bad action: %v", errObj)
	}
	e.advance(11 * time.Minute)
	if r := e.mustOK(asha, "auth.stepUpCheck", map[string]string{"grantId": id, "action": "tally.post"}); r["valid"] != false {
		t.Fatalf("expired: %v", r)
	}
	if e.ag.StepUpValid(id, asha.SID, "tally.post") {
		t.Fatal("grant outlived 10 minutes")
	}
}

func TestAuditAppendValidation(t *testing.T) {
	e := newEnv(t)
	ok := map[string]string{"category": "access_denied", "action": "read", "target": `\\fs\Clients\Mehta\bank.pdf`, "result": "denied"}
	e.mustOK(asha, "audit.append", ok)
	bad := []map[string]string{
		{"category": "made_up", "action": "read", "result": "denied"},
		{"category": "access_denied", "action": "READ!", "result": "denied"},
		{"category": "access_denied", "action": "read", "result": "denied", "target": strings.Repeat("x", 1025)},
	}
	for _, b := range bad {
		if _, errObj := e.call(asha, "audit.append", b); code(errObj) != rpc.CodeInvalidParams {
			t.Errorf("accepted %v: %v", b, errObj)
		}
	}
	if _, errObj := e.call(asha, "audit.append", map[string]string{"category": "access_denied", "action": "read", "result": "denied", "sid": ravi.SID}); code(errObj) != rpc.CodeInvalidParams {
		t.Fatalf("sid in params accepted: %v", errObj)
	}
}

func TestPolicyDefaultsAreSafe(t *testing.T) {
	e := newEnv(t)
	p := e.mustOK(asha, "policy.get", nil)
	if p["telegramMode"] != "off" {
		t.Fatalf("telegram must default to off: %v", p)
	}
}

func TestRegisteredMethodsExistInSharedSchema(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "shared-schema", "schemas", "ipc", "envelope.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Defs struct {
			Method struct {
				Enum []string `json:"enum"`
			} `json:"method"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatal(err)
	}
	known := map[string]bool{}
	for _, m := range schema.Defs.Method.Enum {
		known[m] = true
	}
	srv := rpc.NewServer(nil)
	New(nil, nil, DefaultConfig(), nil).Register(srv)
	ms := srv.Methods()
	sort.Strings(ms)
	for _, m := range ms {
		if !known[m] {
			t.Errorf("method %s is not in the shared IPC schema", m)
		}
	}
}

func TestDayEndRollsOver(t *testing.T) {
	a := New(nil, nil, DefaultConfig(), nil)
	before := time.Date(2026, 11, 23, 21, 59, 0, 0, IST)
	after := time.Date(2026, 11, 23, 22, 30, 0, 0, IST)
	if got := a.dayEnd(before); !got.Equal(time.Date(2026, 11, 23, 22, 0, 0, 0, IST)) {
		t.Fatalf("before: %v", got)
	}
	if got := a.dayEnd(after); !got.Equal(time.Date(2026, 11, 24, 22, 0, 0, 0, IST)) {
		t.Fatalf("after: %v", got)
	}
}

func TestPolicyUsesSyncedConsolePolicy(t *testing.T) {
	e := newEnv(t)
	_ = e.st.SetMeta(context.Background(), "policy_json", `{"policy":{"lockTimeoutMaxMin":10,"dayEndHourIst":20,"telegramMode":"text","telegramAllowedPacks":["core"],"stepUpActions":["tally.post"],"gatewayIdleStopHours":4}}`)
	p := e.mustOK(asha, "policy.get", nil)
	if p["source"] != "console" || p["telegramMode"] != "text" || p["lockTimeoutMax"].(float64) != 10 {
		t.Fatalf("synced policy not used: %v", p)
	}
	_ = e.st.SetMeta(context.Background(), "policy_json", `{"policy":{"telegramMode":"everything"}}`)
	if p := e.mustOK(asha, "policy.get", nil); p["telegramMode"] != "off" {
		t.Fatalf("unknown telegram mode must fall back to off: %v", p)
	}
}

func TestTelegramLinkStartAndUnlock(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if _, errObj := e.call(asha, "telegram.linkStart", nil); code(errObj) != rpc.CodeConflict {
		t.Fatalf("no bot configured: %v", errObj)
	}
	_ = e.st.SetMeta(ctx, MetaBotUsername, "MehtaCABot")
	res := e.mustOK(asha, "telegram.linkStart", nil)
	if !strings.HasPrefix(res["url"].(string), "https://t.me/MehtaCABot?start=") {
		t.Fatalf("url %v", res["url"])
	}
	secret := e.enrol(asha)
	if err := e.ag.TelegramUnlock(ctx, asha.SID, "000000"); err == nil || !strings.Contains(err.Error(), "isn't right") {
		t.Fatalf("wrong code: %v", err)
	}
	e.advance(30 * time.Second)
	if err := e.ag.TelegramUnlock(ctx, asha.SID, e.totp(secret)); err != nil {
		t.Fatalf("unlock: %v", err)
	}
	l, _ := e.st.Lock(ctx, asha.SID)
	if !l.TelegramUnlockedUntil.Equal(e.clock.Add(60 * time.Minute)) {
		t.Fatalf("telegram window %v", l.TelegramUnlockedUntil)
	}
	if st := e.mustOK(asha, "lock.get", nil); st["telegramUnlockedUntil"] == nil {
		t.Fatalf("lock.get must report the Telegram window: %v", st)
	}
	if err := e.ag.TelegramUnlock(ctx, nobod.SID, "123456"); err == nil {
		t.Fatal("unknown SID unlocked")
	}
	if e.ag.TelegramMode(ctx) != "off" || !e.ag.ActiveEmployee(ctx, asha.SID) || e.ag.ActiveEmployee(ctx, nobod.SID) {
		t.Fatal("mode/active hooks wrong")
	}
}

func TestLeaseKeepsProtectedTokenForRelay(t *testing.T) {
	e := newEnv(t)
	s := e.enrol(asha)
	e.advance(30 * time.Second)
	e.mustOK(asha, "auth.verifyDaily", map[string]string{"code": e.totp(s)})
	res := e.mustOK(asha, "gateway.lease", nil)
	blob, err := e.st.LeaseTokenProtected(context.Background(), asha.SID)
	if err != nil || strings.Contains(string(blob), res["token"].(string)) {
		t.Fatalf("protected token: %v (must not be stored in clear)", err)
	}
	plain, err := e.ag.secrets.Unprotect(blob)
	if err != nil || string(plain) != res["token"] {
		t.Fatal("protected token does not round-trip")
	}
}
