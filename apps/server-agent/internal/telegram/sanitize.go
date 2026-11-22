package telegram

import (
	"regexp"
	"strings"
)

// Text-only Telegram must not become a way to move files off the server
// (SECURITY §6, ADR-055). Replies keep their words but lose:
//   - long encoded blobs (base64/hex runs), which could carry a whole file;
//   - links to local files or to services on the server itself (file://, localhost,
//     127.0.0.1, UNC-style \\host\share URLs as links).
// Paths written as plain text (C:\Clients\...) stay: they're useful and carry no content.

var (
	// Unbroken encoded runs of 200+ characters are removed.
	base64Run = regexp.MustCompile(`[A-Za-z0-9+/=_-]{200,}`)
	localLink = regexp.MustCompile(`(?i)\b(?:file:/{2,3}[^\s)>\]]+|https?://(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?[^\s)>\]]*)`)
)

const (
	blobNote = "[long encoded data removed: files can't be sent on Telegram]"
	linkNote = "[link to a file on the server removed]"
)

// SanitizeReply removes encoded file dumps and local links from an assistant reply.
func SanitizeReply(s string) (string, bool) {
	changed := false
	out := base64Run.ReplaceAllStringFunc(s, func(run string) string {
		// Plain long words without digits or symbols (rare) are left alone.
		if !strings.ContainsAny(run, "0123456789+/=") {
			return run
		}
		changed = true
		return blobNote
	})
	out = localLink.ReplaceAllStringFunc(out, func(string) string {
		changed = true
		return linkNote
	})
	return out, changed
}
