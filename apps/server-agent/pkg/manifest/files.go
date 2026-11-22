package manifest

import (
	"archive/zip"
	"crypto/sha256"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// HashFile returns the lowercase hex SHA-256 and size of a file.
func HashFile(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hexSum(h.Sum(nil)), n, nil
}

// ListDir walks dir and returns every regular file as a manifest File, sorted.
// Symlinks, junctions and other non-regular entries are rejected: a payload must
// be plain files only.
func ListDir(dir string) ([]File, error) {
	var files []File
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == dir {
			return nil
		}
		info, err := os.Lstat(p)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("payload contains a symlink: %s", p)
		}
		if d.IsDir() {
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("payload contains a non-regular file: %s", p)
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if err := SafePath(rel); err != nil {
			return err
		}
		sum, size, err := HashFile(p)
		if err != nil {
			return err
		}
		files = append(files, File{Path: rel, SHA256: sum, Size: size})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sortFiles(files)
	return files, nil
}

// zipEpoch is the fixed modification time written into every zip entry so that
// the same payload always produces the same zip bytes (reproducible releases).
var zipEpoch = time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)

// WriteZip writes the listed files from dir into a deterministic zip at dest.
func WriteZip(dir string, files []File, dest string) error {
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	zw := zip.NewWriter(out)
	for _, f := range files {
		if err := addZipFile(zw, dir, f); err != nil {
			_ = zw.Close()
			_ = out.Close()
			return err
		}
	}
	if err := zw.Close(); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

func addZipFile(zw *zip.Writer, dir string, f File) error {
	hdr := &zip.FileHeader{Name: f.Path, Method: zip.Deflate, Modified: zipEpoch}
	hdr.SetMode(0o644)
	w, err := zw.CreateHeader(hdr)
	if err != nil {
		return err
	}
	src, err := os.Open(filepath.Join(dir, filepath.FromSlash(f.Path)))
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()
	_, err = io.Copy(w, src)
	return err
}

// VerifyFileHash checks a file on disk against an expected SHA-256 and size.
func VerifyFileHash(path, wantSHA string, wantSize int64) error {
	sum, size, err := HashFile(path)
	if err != nil {
		return err
	}
	if sum != wantSHA || size != wantSize {
		return fmt.Errorf("%w: %s", ErrHashMismatch, filepath.Base(path))
	}
	return nil
}

// VerifyDir checks that dir contains exactly the manifest's files with matching
// hashes: nothing missing, nothing extra, nothing changed.
func VerifyDir(dir string, m *Manifest) error {
	got, err := ListDir(dir)
	if err != nil {
		return err
	}
	want := make(map[string]File, len(m.Files))
	for _, f := range m.Files {
		want[f.Path] = f
	}
	for _, g := range got {
		w, ok := want[g.Path]
		if !ok {
			return fmt.Errorf("%w: %s", ErrUnexpectedFile, g.Path)
		}
		if w.SHA256 != g.SHA256 || w.Size != g.Size {
			return fmt.Errorf("%w: %s", ErrHashMismatch, g.Path)
		}
		delete(want, g.Path)
	}
	for p := range want {
		return fmt.Errorf("%w: %s", ErrMissingFile, p)
	}
	return nil
}

// ExtractZip unpacks a payload zip into dest (which must not exist yet). Only
// entries listed in the manifest are accepted; each is size-limited to its
// manifest size and hash-checked while writing. Any problem removes dest.
func ExtractZip(zipPath, dest string, m *Manifest) (err error) {
	if _, statErr := os.Lstat(dest); statErr == nil {
		return fmt.Errorf("destination already exists: %s", dest)
	}
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer func() { _ = zr.Close() }()

	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = os.RemoveAll(dest)
		}
	}()

	want := make(map[string]File, len(m.Files))
	for _, f := range m.Files {
		want[f.Path] = f
	}
	done := make(map[string]bool, len(m.Files))
	for _, zf := range zr.File {
		if strings.HasSuffix(zf.Name, "/") { // directory entry
			if err := SafePath(strings.TrimSuffix(zf.Name, "/")); err != nil {
				return err
			}
			continue
		}
		mf, ok := want[zf.Name]
		if !ok {
			return fmt.Errorf("%w: %s", ErrUnexpectedFile, zf.Name)
		}
		if done[zf.Name] {
			return fmt.Errorf("duplicate zip entry: %s", zf.Name)
		}
		if err := extractOne(zf, dest, mf); err != nil {
			return err
		}
		done[zf.Name] = true
	}
	if len(done) != len(want) {
		for p := range want {
			if !done[p] {
				return fmt.Errorf("%w: %s", ErrMissingFile, p)
			}
		}
	}
	return nil
}

func extractOne(zf *zip.File, dest string, mf File) error {
	if zf.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("zip entry is a symlink: %s", zf.Name)
	}
	if int64(zf.UncompressedSize64) != mf.Size { //nolint:gosec // sizes are bounded by the manifest check
		return fmt.Errorf("%w: size of %s", ErrHashMismatch, zf.Name)
	}
	target := filepath.Join(dest, filepath.FromSlash(mf.Path))
	if rel, err := filepath.Rel(dest, target); err != nil || strings.HasPrefix(rel, "..") {
		return fmt.Errorf("zip entry escapes destination: %s", zf.Name)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	rc, err := zf.Open()
	if err != nil {
		return err
	}
	defer func() { _ = rc.Close() }()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	h := sha256.New()
	// Read at most size+1 bytes so a lying header can't inflate a zip bomb.
	n, copyErr := io.Copy(io.MultiWriter(out, h), io.LimitReader(rc, mf.Size+1))
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if n != mf.Size || hexSum(h.Sum(nil)) != mf.SHA256 {
		return fmt.Errorf("%w: %s", ErrHashMismatch, mf.Path)
	}
	return nil
}
