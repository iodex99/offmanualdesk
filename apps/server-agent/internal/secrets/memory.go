package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"fmt"
)

// Memory is an AES-GCM Protector with a random per-process key. It exists for
// tests and non-Windows development only: blobs don't survive a restart.
type Memory struct{ aead cipher.AEAD }

// NewMemory creates a Memory protector.
func NewMemory() (*Memory, error) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("memory protector key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Memory{aead: aead}, nil
}

// Protect encrypts plain.
func (m *Memory) Protect(plain []byte) ([]byte, error) {
	if len(plain) == 0 {
		return nil, ErrEmpty
	}
	nonce := make([]byte, m.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return m.aead.Seal(nonce, nonce, plain, entropy), nil
}

// Unprotect decrypts a blob.
func (m *Memory) Unprotect(b []byte) ([]byte, error) {
	n := m.aead.NonceSize()
	if len(b) < n {
		return nil, ErrUnprotect
	}
	out, err := m.aead.Open(nil, b[:n], b[n:], entropy)
	if err != nil {
		return nil, ErrUnprotect
	}
	return out, nil
}
