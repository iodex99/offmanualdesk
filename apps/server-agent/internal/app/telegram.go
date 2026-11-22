package app

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"log/slog"
	"strings"
	"time"

	"offmanual/desk/server-agent/internal/agent"
	"offmanual/desk/server-agent/internal/gateway"
	"offmanual/desk/server-agent/internal/secrets"
	"offmanual/desk/server-agent/internal/store"
	"offmanual/desk/server-agent/internal/telegram"
	"offmanual/desk/server-agent/internal/version"
)

// Meta keys for Telegram.
const (
	MetaBotToken    = "telegram_bot_token_dpapi" //nolint:gosec // G101: a meta key name, not a credential
	MetaRelayDevice = "relay_device_key_dpapi"
	// TelegramSessionKey is the session Telegram turns run in; the guard recognises
	// ":telegram" in the key (ADR-023). [UNVERIFIED: accepted session key formats, lab L2]
	TelegramSessionKey = "agent:main:telegram"
	relayLeaseFresh    = 12 * time.Hour
)

// SetupTelegram stores the firm bot's token (DPAPI) and username.
func SetupTelegram(ctx context.Context, dataDir, username, token string) error {
	if protector == nil {
		return ErrUnsupported
	}
	username = strings.TrimPrefix(strings.TrimSpace(username), "@")
	token = strings.TrimSpace(token)
	if username == "" || !strings.HasSuffix(strings.ToLower(username), "bot") || !strings.Contains(token, ":") {
		return errors.New("give the bot's @username (ends in 'bot') and the token from BotFather")
	}
	if dataDir == "" {
		dataDir = DefaultDataDir()
	}
	st, err := store.Open(ctx, dataDir+`\agent.db`)
	if err != nil {
		return err
	}
	defer func() { _ = st.Close() }()
	p, err := protector()
	if err != nil {
		return err
	}
	blob, err := p.Protect([]byte(token))
	if err != nil {
		return err
	}
	if err := st.SetMeta(ctx, MetaBotToken, string(blob)); err != nil {
		return err
	}
	return st.SetMeta(ctx, agent.MetaBotUsername, username)
}

func relayDevice(ctx context.Context, st *store.Store, p secrets.Protector) (gateway.Device, error) {
	if v, err := st.Meta(ctx, MetaRelayDevice); err == nil {
		if seed, err := p.Unprotect([]byte(v)); err == nil && len(seed) == ed25519.SeedSize {
			return gateway.Device{Key: ed25519.NewKeyFromSeed(seed)}, nil
		}
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return gateway.Device{}, err
	}
	blob, err := p.Protect(seed)
	if err != nil {
		return gateway.Device{}, err
	}
	if err := st.SetMeta(ctx, MetaRelayDevice, string(blob)); err != nil {
		return gateway.Device{}, err
	}
	return gateway.Device{Key: ed25519.NewKeyFromSeed(seed)}, nil
}

// newRelay returns the Telegram → gateway relay (ADR-023). It only talks to a gateway
// that Desk started (a fresh lease); logged-off employees get "open Desk" (ADR-026).
func newRelay(st *store.Store, p secrets.Protector) func(ctx context.Context, sid string, _ int64, text string) (string, error) {
	return func(ctx context.Context, sid string, _ int64, text string) (string, error) {
		lease, err := st.LeaseFor(ctx, sid)
		if err != nil || time.Since(lease.LastSeenAt) > relayLeaseFresh {
			return "", telegram.ErrNotRunning
		}
		blob, err := st.LeaseTokenProtected(ctx, sid)
		if err != nil {
			return "", telegram.ErrNotRunning
		}
		token, err := p.Unprotect(blob)
		if err != nil {
			return "", telegram.ErrNotRunning
		}
		dev, err := relayDevice(ctx, st, p)
		if err != nil {
			return "", err
		}
		dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		c, err := gateway.Dial(dctx, gateway.Options{Port: lease.Port, Token: string(token), Device: dev, Version: version.Get().Version})
		cancel()
		if err != nil {
			return "", telegram.ErrNotRunning
		}
		defer func() { _ = c.Close() }()
		return c.Chat(ctx, TelegramSessionKey, text)
	}
}

// startTelegram runs the router if a bot token is configured.
func startTelegram(ctx context.Context, st *store.Store, p secrets.Protector, ag *agent.Agent, log *slog.Logger) {
	v, err := st.Meta(ctx, MetaBotToken)
	if err != nil {
		return // not configured
	}
	token, err := p.Unprotect([]byte(v))
	if err != nil {
		log.Error("telegram token unreadable; run telegram-setup again")
		return
	}
	bot := telegram.NewBot(string(token))
	r := &telegram.Router{Store: st, Send: bot, Log: log, Hooks: telegram.Hooks{
		Mode:   ag.TelegramMode,
		Relay:  newRelay(st, p),
		Unlock: ag.TelegramUnlock,
		Active: ag.ActiveEmployee,
		Paused: ag.PausedMessage,
	}}
	log.Info("telegram router started")
	go r.Run(ctx, bot)
}
