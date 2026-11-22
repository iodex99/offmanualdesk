package manifest

import (
	"embed"
	"fmt"
	"io/fs"
	"regexp"
	"strconv"
	"strings"
)

// keysFS holds the release-signing public keys compiled into the agent
// (keys/<key-id>.pub, base64 ed25519). Removing a file and shipping a release
// revokes that key (keys/README.md).
//
//go:embed keys
var keysFS embed.FS

// TrustedKeys returns the compiled-in keyring. Malformed files are an error: a
// broken build must not silently trust nothing (or the wrong thing).
func TrustedKeys() (Keyring, error) {
	return keyringFrom(keysFS)
}

func keyringFrom(fsys fs.FS) (Keyring, error) {
	entries, err := fs.ReadDir(fsys, "keys")
	if err != nil {
		return nil, err
	}
	ring := Keyring{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".pub") {
			continue
		}
		id := strings.TrimSuffix(name, ".pub")
		if !keyIDRe.MatchString(id) {
			return nil, fmt.Errorf("bad key file name %q", name)
		}
		b, err := fs.ReadFile(fsys, "keys/"+name)
		if err != nil {
			return nil, err
		}
		pub, err := ParsePublicKey(string(b))
		if err != nil {
			return nil, fmt.Errorf("key %s: %w", id, err)
		}
		ring[id] = pub
	}
	return ring, nil
}

var semverParts = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$`)

// CompareVersions compares two semver strings (-1, 0, 1). A pre-release sorts before
// its release; pre-release identifiers compare as plain strings (enough for -rc.N).
func CompareVersions(a, b string) (int, error) {
	ma, mb := semverParts.FindStringSubmatch(a), semverParts.FindStringSubmatch(b)
	if ma == nil || mb == nil {
		return 0, fmt.Errorf("not semver: %q / %q", a, b)
	}
	for i := 1; i <= 3; i++ {
		x, _ := strconv.Atoi(ma[i])
		y, _ := strconv.Atoi(mb[i])
		if x != y {
			if x < y {
				return -1, nil
			}
			return 1, nil
		}
	}
	switch {
	case ma[4] == mb[4]:
		return 0, nil
	case ma[4] == "":
		return 1, nil
	case mb[4] == "":
		return -1, nil
	case ma[4] < mb[4]:
		return -1, nil
	default:
		return 1, nil
	}
}
