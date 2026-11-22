// Package version holds build metadata injected at link time:
//
//	go build -ldflags "-X offmanual/desk/server-agent/internal/version.Version=1.2.3 -X offmanual/desk/server-agent/internal/version.Commit=abc123"
package version

import "runtime"

// Set by -ldflags at release build time. Defaults apply to local/dev builds.
var (
	Version = "0.0.0-dev"
	Commit  = "unknown"
)

// Info is the machine-readable build description printed by `server-agent version`.
type Info struct {
	Name      string `json:"name"`
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	GoVersion string `json:"goVersion"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
}

// Get returns the build info for this binary.
func Get() Info {
	return Info{
		Name:      "offmanual-server-agent",
		Version:   Version,
		Commit:    Commit,
		GoVersion: runtime.Version(),
		OS:        runtime.GOOS,
		Arch:      runtime.GOARCH,
	}
}
