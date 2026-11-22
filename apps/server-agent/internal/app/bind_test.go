package app

import (
	"context"
	"crypto/ed25519"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"offmanual/desk/server-agent/internal/agent"
	"offmanual/desk/server-agent/internal/console"
)

func TestBinderForMapsConsoleAnswers(t *testing.T) {
	status, body := 0, ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	c := &console.Client{BaseURL: srv.URL, ServerID: "srv_0123456789abcdef0123456789abcdef", Key: ed25519.NewKeyFromSeed(make([]byte, 32))}
	bind := binderFor(c)

	status, body = 409, `{"error":"This Windows account is already linked to someone else. Ask your admin."}`
	_, err := bind(context.Background(), "ABCD-EFGH", "S-1-5-21-1-2-3-4")
	var um agent.UserMessage
	if !errors.As(err, &um) || string(um) != "This Windows account is already linked to someone else. Ask your admin." {
		t.Fatalf("409: %v", err)
	}
	// A signature problem is ours, not the employee's: never shown as a user message.
	status, body = 401, `{"error":"bad signature"}`
	if _, err := bind(context.Background(), "X", "S-1-5-21-1-2-3-4"); err == nil || errors.As(err, &um) {
		t.Fatalf("401: %v", err)
	}
	status, body = 200, `{"employeeId":"e-1","name":"Asha","status":"active","packs":["core"]}`
	r, err := bind(context.Background(), "ABCD-EFGH", "S-1-5-21-1-2-3-4")
	if err != nil || r.EmployeeID != "e-1" || r.Packs[0] != "core" {
		t.Fatalf("ok: %+v %v", r, err)
	}
}
