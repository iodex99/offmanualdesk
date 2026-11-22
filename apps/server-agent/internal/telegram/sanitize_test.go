package telegram

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
)

func TestSanitizeReply(t *testing.T) {
	blob := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("bank statement row,", 30)))
	cases := []struct {
		in       string
		changed  bool
		contains []string
		absent   []string
	}{
		{`42 clients are pending. See C:\Clients\Mehta\notes.xlsx`, false, []string{`C:\Clients\Mehta`}, nil},
		{"Here it is: " + blob, true, []string{blobNote}, []string{blob[:50]}},
		{"Download http://127.0.0.1:18800/files/x.pdf now", true, []string{linkNote}, []string{"127.0.0.1"}},
		{"Open file:///C:/Clients/a.pdf", true, []string{linkNote}, []string{"file://"}},
		{"See https://localhost/x and https://www.gst.gov.in/", true, []string{linkNote, "https://www.gst.gov.in/"}, []string{"localhost"}},
		{"Hex: " + strings.Repeat("a1", 150), true, []string{blobNote}, nil},
		{strings.Repeat("abcdefghij", 25), false, nil, nil}, // a long plain word is not a file
	}
	for i, c := range cases {
		out, changed := SanitizeReply(c.in)
		if changed != c.changed {
			t.Fatalf("case %d: changed=%v", i, changed)
		}
		for _, s := range c.contains {
			if !strings.Contains(out, s) {
				t.Fatalf("case %d: %q missing in %q", i, s, out)
			}
		}
		for _, s := range c.absent {
			if strings.Contains(out, s) {
				t.Fatalf("case %d: %q still in %q", i, s, out)
			}
		}
	}
}

func TestRelayRepliesAreSanitized(t *testing.T) {
	e := newEnv(t)
	e.link(t, 777)
	e.relay = func(string) (string, error) { return "Here: http://localhost:18800/x.pdf", nil }
	e.r.Handle(context.Background(), msg(777, "send me the file"))
	if strings.Contains(e.out.last(), "localhost") || !strings.Contains(e.out.last(), linkNote) {
		t.Fatalf("reply %q", e.out.last())
	}
}
