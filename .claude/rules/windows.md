---
paths:
  - "apps/server-agent/**"
  - "apps/desk/src-tauri/**"
  - "installer/**"
  - "lab/**"
---

# Windows rules

- Target: Windows Server 2022 with RDS Session Host (many users at once). Also test on Windows 11 for dev.
- Assume many sessions: no global singletons except in the Server Agent; per-session resources keyed by session ID + SID.
- Paths: never hard-code `C:\Users\…`; use known-folder APIs. Use UNC paths for shares (mapped drives may not exist in child or scheduled processes).
- Secrets at rest: DPAPI (CurrentUser for per-user, LocalMachine for the service), never plain files.
- Code that only runs on Windows sits behind build tags / `cfg(windows)` with fakes for CI on Linux; Windows paths also run on the `windows-latest` CI runner.
- PowerShell lab scripts: `Set-StrictMode -Version Latest`, `$ErrorActionPreference = 'Stop'`, print a clear PASS/FAIL line and the values Dwahnil must paste back.
- Anything that depends on an unrun LAB_VALIDATION item must say so in a code comment with the item ID.
