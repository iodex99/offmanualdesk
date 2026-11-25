// Package telegram runs the firm's single Telegram bot for every employee
// (ADR-005, ADR-023; docs/ARCHITECTURE.md F7–F8). Bot API reference:
// https://core.telegram.org/bots/api (getUpdates, sendMessage).
package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// MaxMessageLen is Telegram's limit for one text message (sendMessage: 1-4096 characters).
const MaxMessageLen = 4096

// User is the sender of a message.
type User struct {
	ID    int64 `json:"id"`
	IsBot bool  `json:"is_bot"`
}

// Chat is where a message was sent.
type Chat struct {
	ID   int64  `json:"id"`
	Type string `json:"type"`
}

// Message is the subset of Telegram's Message we use. Document/Photo are only
// checked for presence: files are never downloaded in text-only mode.
type Message struct {
	MessageID int64           `json:"message_id"`
	From      *User           `json:"from"`
	Chat      Chat            `json:"chat"`
	Text      string          `json:"text"`
	Document  json.RawMessage `json:"document,omitempty"`
	Photo     json.RawMessage `json:"photo,omitempty"`
}

// Update is one item from getUpdates.
type Update struct {
	UpdateID      int64          `json:"update_id"`
	Message       *Message       `json:"message"`
	CallbackQuery *CallbackQuery `json:"callback_query,omitempty"`
}

// CallbackQuery is a tap on an inline button (Bot API: id, from, message as
// MaybeInaccessibleMessage, data ≤ 64 bytes). Chat and message_id are present
// even when the message is no longer accessible.
type CallbackQuery struct {
	ID      string   `json:"id"`
	From    *User    `json:"from"`
	Message *Message `json:"message,omitempty"`
	Data    string   `json:"data"`
}

// Bot is a minimal Bot API client.
type Bot struct {
	BaseURL string // https://api.telegram.org/bot<token> (tests use a local server)
	HTTP    *http.Client
}

// NewBot builds a client for a bot token. The token is a secret: never log BaseURL.
func NewBot(token string) *Bot {
	return &Bot{BaseURL: "https://api.telegram.org/bot" + token, HTTP: &http.Client{Timeout: 70 * time.Second}}
}

type apiResponse struct {
	OK          bool            `json:"ok"`
	Result      json.RawMessage `json:"result"`
	Description string          `json:"description"`
}

func (b *Bot) call(ctx context.Context, method string, params any, out any) error {
	body, err := json.Marshal(params)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.BaseURL+"/"+method, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := b.HTTP.Do(req)
	if err != nil {
		return errors.New("telegram request failed") // the URL holds the bot token: don't wrap it
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	var r apiResponse
	if err := json.Unmarshal(raw, &r); err != nil {
		return fmt.Errorf("telegram %s: bad response (HTTP %d)", method, resp.StatusCode)
	}
	if !r.OK {
		return fmt.Errorf("telegram %s: %s", method, r.Description)
	}
	if out != nil {
		return json.Unmarshal(r.Result, out)
	}
	return nil
}

// GetUpdates long-polls for new messages (allowed_updates: message only).
func (b *Bot) GetUpdates(ctx context.Context, offset int64, timeoutSec int) ([]Update, error) {
	var ups []Update
	err := b.call(ctx, "getUpdates", map[string]any{
		"offset": offset, "timeout": timeoutSec, "allowed_updates": []string{"message", "callback_query"},
	}, &ups)
	return ups, err
}

// SendMessage sends plain text (no parse mode, so nothing is interpreted as markup).
func (b *Bot) SendMessage(ctx context.Context, chatID int64, text string) error {
	return b.call(ctx, "sendMessage", map[string]any{"chat_id": chatID, "text": text}, nil)
}

// SendApproval sends text with Approve and Deny buttons; callback data is
// "ua:<id>" / "ud:<id>" (≤ 64 bytes as the Bot API requires).
func (b *Bot) SendApproval(ctx context.Context, chatID int64, text, requestID string) error {
	return b.call(ctx, "sendMessage", map[string]any{
		"chat_id": chatID,
		"text":    text,
		"reply_markup": map[string]any{"inline_keyboard": [][]map[string]string{{
			{"text": "Approve", "callback_data": "ua:" + requestID},
			{"text": "Deny", "callback_data": "ud:" + requestID},
		}}},
	}, nil)
}

// AnswerCallback stops the button's spinner and shows a short note (≤ 200 characters).
func (b *Bot) AnswerCallback(ctx context.Context, callbackID, text string) error {
	if r := []rune(text); len(r) > 200 {
		text = string(r[:200])
	}
	return b.call(ctx, "answerCallbackQuery", map[string]any{"callback_query_id": callbackID, "text": text}, nil)
}

// EditMessageText replaces a bot message's text and removes its buttons (an empty
// inline keyboard is sent explicitly).
func (b *Bot) EditMessageText(ctx context.Context, chatID, messageID int64, text string) error {
	return b.call(ctx, "editMessageText", map[string]any{
		"chat_id": chatID, "message_id": messageID, "text": text,
		"reply_markup": map[string]any{"inline_keyboard": [][]map[string]string{}},
	}, nil)
}

// Chunks splits text into Telegram-sized parts on rune boundaries, preferring newlines.
func Chunks(text string) []string {
	r := []rune(text)
	var out []string
	for len(r) > MaxMessageLen {
		cut := MaxMessageLen
		for i := MaxMessageLen; i > MaxMessageLen/2; i-- {
			if r[i-1] == '\n' {
				cut = i
				break
			}
		}
		out = append(out, string(r[:cut]))
		r = r[cut:]
	}
	if len(r) > 0 || len(out) == 0 {
		out = append(out, string(r))
	}
	return out
}

// FormatOffset is used to store the update offset in meta.
func FormatOffset(o int64) string { return strconv.FormatInt(o, 10) }
