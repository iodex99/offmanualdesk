package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"
)

func hashCode(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

// CreateLinkCode stores a one-time Telegram link code (only its hash) for sid.
func (s *Store) CreateLinkCode(ctx context.Context, sid, code string, ttl time.Duration) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO telegram_link_codes (code_hash, sid, expires_at) VALUES (?, ?, ?)`,
		hashCode(code), sid, s.now().Add(ttl).Unix())
	return err
}

// ConsumeLinkCode links telegramUserID to the code's SID if the code is unused and
// unexpired. Returns the SID. A Telegram account can be linked to one SID only.
func (s *Store) ConsumeLinkCode(ctx context.Context, code string, telegramUserID int64) (string, error) {
	var sid string
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, `SELECT sid FROM telegram_link_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
			hashCode(code), s.now().Unix()).Scan(&sid)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE telegram_link_codes SET used_at = ? WHERE code_hash = ?`, s.now().Unix(), hashCode(code)); err != nil {
			return err
		}
		// Re-linking replaces any previous link for this SID or this Telegram account.
		if _, err := tx.ExecContext(ctx, `DELETE FROM telegram_links WHERE sid = ? OR telegram_user_id = ?`, sid, telegramUserID); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO telegram_links (sid, telegram_user_id, linked_at) VALUES (?, ?, ?)`, sid, telegramUserID, s.now().Unix())
		return err
	})
	return sid, err
}

// SIDForTelegramUser returns the linked SID or ErrNotFound.
func (s *Store) SIDForTelegramUser(ctx context.Context, telegramUserID int64) (string, error) {
	var sid string
	err := s.db.QueryRowContext(ctx, `SELECT sid FROM telegram_links WHERE telegram_user_id = ?`, telegramUserID).Scan(&sid)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return sid, err
}

// UnlinkTelegram removes an employee's Telegram link (offboarding, F10).
func (s *Store) UnlinkTelegram(ctx context.Context, sid string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM telegram_links WHERE sid = ?`, sid)
	return err
}

// SetLeaseTokenProtected stores the DPAPI-protected gateway token for the relay.
func (s *Store) SetLeaseTokenProtected(ctx context.Context, sid string, blob []byte) error {
	return s.exec1(ctx, `UPDATE leases SET token_dpapi = ? WHERE sid = ?`, blob, sid)
}

// LeaseTokenProtected returns the protected token blob of sid's lease.
func (s *Store) LeaseTokenProtected(ctx context.Context, sid string) ([]byte, error) {
	var b []byte
	err := s.db.QueryRowContext(ctx, `SELECT token_dpapi FROM leases WHERE sid = ?`, sid).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && len(b) == 0) {
		return nil, ErrNotFound
	}
	return b, err
}

// TelegramUserForSID returns the Telegram user linked to sid (ErrNotFound if none).
func (s *Store) TelegramUserForSID(ctx context.Context, sid string) (int64, error) {
	var id int64
	err := s.db.QueryRowContext(ctx, `SELECT telegram_user_id FROM telegram_links WHERE sid = ?`, sid).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return id, err
}
