# Architecture decisions

Status values: **Accepted**, **Proposed** (needs a lab result or Dwahnil's call before building on it), **Superseded by ADR-0xx**. Never delete an ADR. New ADRs go at the end; use `/adr`.

Template:

```
## ADR-0xx: <title>
- Date: YYYY-MM-DD
- Status: Proposed | Accepted | Superseded by ADR-0yy
- Context: why a decision was needed
- Options: A … / B … / C …
- Decision: …
- Consequences: what this makes easy, what it makes hard, what to revisit
- Depends on: lab item / other ADR (if any)
```

---

## ADR-001: One OpenClaw gateway per employee, as that employee's Windows account
- Date: 2026-11-22
- Status: Accepted (capacity numbers pending L1)
- Context: OpenClaw assumes one trust boundary per gateway; its docs say it is not a multi-tenant boundary for users who don't trust each other and recommend separate gateways, ideally separate OS users. Multi-user mode features are usability, not security.
- Options: A one shared gateway + own permission layer / B one gateway per employee as their Windows user / C one VM per employee
- Decision: B.
- Consequences: Windows enforces file access for free; RAM scales with active employees (mitigated by start-on-demand, stop-on-idle); each gateway needs its own port and token.
- Depends on: L1, L2, L5

## ADR-002: No own file-permission layer; capabilities via skill packs from AD groups
- Date: 2026-11-22
- Status: Accepted
- Context: Firms already maintain NTFS/share rights on their file server. A second permission system confuses admins and drifts.
- Decision: File access = Windows only. Capabilities (email, Tally post, portals, Telegram files) = skill packs mapped from AD groups (`OM-*`), with console overrides for firms without AD.
- Consequences: Admin changes rights in one place. We must surface Access Denied clearly and never work around it.

## ADR-003: Native Windows OpenClaw, pinned version
- Date: 2026-11-22
- Status: Proposed (confirm in M1 research + L1)
- Context: OpenClaw supports a native Windows CLI and gateway with Scheduled Task startup; WSL2 is the most compatible runtime but a WSL2 VM per user on a shared RDS host is heavy.
- Decision: Native Windows. WSL2 only if L1 fails.
- Consequences: Some skills that assume Linux tools need Windows variants; vet each.

## ADR-004: Private signed skill registry; no ClawHub at runtime
- Date: 2026-11-22
- Status: Accepted
- Context: ClawHub had hundreds of malicious skills in early 2026 (Koi Security: 341 of 2,857; Snyk: 13.4% with critical issues).
- Decision: Skills are vendored into `skills/`, pinned by SHA-256, read line by line, scanned, signed into the release. Runtime installs disabled.
- Consequences: Every upstream skill update costs review time; this is part of what the AMC pays for.

## ADR-005: One firm Telegram bot routed by the Server Agent
- Date: 2026-11-22
- Status: Proposed (wake-on-message depends on L6)
- Context: A bot token supports one polling consumer, so per-employee gateways can't share a bot; per-employee BotFather setup is too much friction.
- Decision: Server Agent polls the firm bot and routes by linked Telegram user ID to each gateway's `channel-relay` plugin over the named pipe. Linking via `t.me/<bot>?start=<one-time code>`. OpenClaw's own Telegram channel stays off.
- Consequences: Server Agent sees message text in transit (never stores it). Per-employee bots remain an option.

## ADR-006: Identity = Google/Microsoft OAuth bound to Windows SID + mandatory TOTP; daily code + PIN; step-up
- Date: 2026-11-22
- Status: Accepted
- Decision: First sign-in via OAuth in the system browser, console binds the account to the Windows SID the admin entered. TOTP enrolment mandatory. Daily: TOTP once per working day; idle lock unlocked by PIN; TOTP again for firm-listed sensitive actions. TOTP secrets and PIN hashes are verified by the Server Agent (works when the internet is down).
- Consequences: Server Agent holds TOTP secrets encrypted with DPAPI (machine scope); console holds the master copy encrypted at rest.

## ADR-007: Desk on Tauri 2
- Date: 2026-11-22
- Status: Proposed (confirm WebView2 on Windows Server 2022 in L9)
- Context: Desk runs once per RDS session; 30 sessions × Electron's footprint is expensive.
- Options: Electron / Tauri 2 / WinUI 3
- Decision: Tauri 2 with a React + TypeScript UI; installer bundles the WebView2 runtime bootstrapper.
- Consequences: Rust for the native side (pipes, DPAPI, hotkeys, shell extension registration).

## ADR-008: Server Agent in Go
- Date: 2026-11-22
- Status: Accepted
- Decision: Go for a single signed binary, solid Windows service support, named pipes and crypto in the standard library or well-known packages.

## ADR-009: Console on Next.js + Postgres + Drizzle on Vercel; Razorpay; Resend
- Date: 2026-11-22
- Status: Accepted
- Decision: Matches Dwahnil's existing web stack; Razorpay for INR payments, UPI AutoPay, e-mandates; Resend for email.

## ADR-010: Updates side by side, rings, per-user restart
- Date: 2026-11-22
- Status: Accepted
- Decision: Releases unpack to `versions/<semver>/`; each employee switches on "Restart to update"; security releases carry a deadline; last two versions kept for rollback; rings 0 (lab) → 1 (pilot) → 2 (all); per-firm pin.

## ADR-011: LLM key owned by the firm by default
- Date: 2026-11-22
- Status: Accepted
- Decision: Default: firm's own provider key, DPAPI-encrypted on the server; Off Manual sees token counts only. Option: Off Manual's key with metered pass-through (contract line type `usage`).

## ADR-012: Tally read-only by default; posting via review queue to own session's instance
- Date: 2026-11-22
- Status: Proposed (depends on L4)
- Context: Tally's XML port carries no Windows identity; with multi-user Tally on one host each session needs its own port and any session can reach any port.
- Decision: Read-only skills by default; posting only for the Tally-post pack, only to the port leased to the employee's own session, every voucher through the review queue with read-back check.

## ADR-013: Server Agent ↔ console auth by signed requests
- Date: 2026-11-22
- Status: Accepted (format in ADR-035)
- Decision: At enrolment the agent generates an ed25519 keypair; the console stores the public key against the server. Every request carries a signature over method, path, timestamp and body hash; console rejects skew > 5 minutes. Avoids mTLS on Vercel.

## ADR-014: Seat counting mode is per contract
- Date: 2026-11-22
- Status: Accepted
- Context: The plan mentioned both "active at any point in the month" and "prorated mid-month".
- Decision: Contract field `seat_count_mode`: `prorated_enabled_days` (default: each enabled seat × days enabled ÷ days in month) or `peak_active` (highest number of employees active on any day).

## ADR-015: Release manifest signed as exact bytes with a detached ed25519 signature
- Date: 2026-11-22
- Status: Accepted
- Context: UPDATES.md §1 asks for an ed25519-signed manifest with file and payload hashes. Signing parsed JSON needs a canonical form; Go, Node and future tools would each have to agree on it.
- Options: A JSON canonicalisation (RFC 8785) + embedded signature / B detached signature over the exact bytes of `manifest.json` / C minisign/signify files
- Decision: B. `manifest.json` is written once by `tools/sign-manifest`; `manifest.sig.json` = `{schema, alg: "ed25519", keyId, sig}` over `"offmanual-release-manifest-v1\n" || bytes` (domain separation). Verifiers check the signature before parsing, then parse strictly (unknown fields rejected), then require `manifest.keyId == sig.keyId`. Payload zip is deterministic (sorted entries, fixed timestamps). Extraction accepts only listed files, size-limited and hash-checked while writing; paths are validated against zip-slip and Windows quirks (`SafePath`). Code: `apps/server-agent/pkg/manifest` (shared by the Server Agent and `tools/sign-manifest`); JSON Schema mirror in `packages/shared-schema` with a shared golden fixture tested from both languages.
- Consequences: No canonicalisation bugs; a single changed byte fails. Key rotation = add `<keyId>.pub`, ship a release signed by the old key, switch `RELEASE_KEY_ID`.

## ADR-016: Release store: GitHub Releases now, Cloudflare R2 (or S3) with console-issued URLs before the pilot
- Date: 2026-11-22
- Status: Accepted: option B (R2, private, console-issued URLs) (Dwahnil, 2026-11-22: "do everything": recommended option accepted; revisit any time)
- Context: UPDATES.md names "R2/S3" but no account exists yet. The repo is private, so GitHub Release assets need a GitHub token to download, which must never sit on a firm's server.
- Options: A GitHub Releases only (agents would need a GitHub token: rejected) / B R2 bucket, private, console hands each server a short-lived presigned URL after verifying its signed request / C public R2 bucket (payload is signed anyway; but exposes build contents)
- Decision: Release workflow always attaches artifacts to a GitHub pre-release (internal record) and uploads to R2/S3 when `RELEASE_STORE_*` secrets exist. Recommend B for servers (M8).
- Consequences: Until the store exists, releases are internal only, which is fine before M8. Needs a Cloudflare account (R2 has no egress fees) or S3.

## ADR-017: Release preparation is a local command; CI never commits back
- Date: 2026-11-22
- Status: Accepted
- Context: UPDATES.md §1 step 9 said the workflow moves CHANGELOG Unreleased → version and commits back. A tag then points at a commit whose CHANGELOG doesn't have its own section, and CI would need write access to `main`.
- Options: A workflow commits back to main after tagging / B `node tools/release/cli.mjs prepare <v>` rolls CHANGELOG and bumps every versioned file before the tag; the workflow only checks
- Decision: B. The workflow runs `check-tag` (every versioned file + CHANGELOG section must match the tag) and takes release notes from that section.
- Consequences: CI keeps read-only `contents` permission except the publish job; the tagged commit is self-consistent.

## ADR-018: Monorepo toolchain pins
- Date: 2026-11-22
- Status: Accepted
- Context: M0 needs one way to build, lint and test four deliverables.
- Decision: pnpm workspaces (version in `package.json` `packageManager`) for TS; workspace packages export TypeScript sources (`exports` → `src/*.ts`), consumers transpile (Next `transpilePackages`, Vite, Vitest), so no package needs a pre-build. TypeScript pinned to `~6.0.3` because typescript-eslint 8.x supports `<6.1` (TS 7 is the new native compiler with a different API; revisit when typescript-eslint supports it). ESLint 10 flat config at the root; Prettier 3. Go: `go.work` with modules `offmanual/desk/server-agent` and `offmanual/desk/tools/sign-manifest` (local module paths, never fetched); golangci-lint v2. Rust: stable, MSVC toolchain in CI (`windows-latest`), `Cargo.lock` committed, clippy `-D warnings`. Node 22 LTS for tooling (`.nvmrc`).
- Consequences: Local Rust compile needs Visual Studio Build Tools (MSVC); on Dwahnil's dev machine only `cargo fmt` runs today and CI is the authority for Rust builds.

## ADR-019: Pin OpenClaw 2026.11.6 for development; production channel decided before the pilot
- Date: 2026-11-22
- Status: Accepted, including option B for production (Dwahnil, 2026-11-22: "do everything": recommended option accepted; revisit any time)
- Context: M1 research (docs/OPENCLAW_NOTES.md §1). Latest stable is 2026.11.6 (tag `v2026.11.6`, commit `06afb10d`, 2026-11-19, npm integrity `sha512-4MGjAMv8…`). Upstream also has `extended-stable` (2026.10.33, "our current equivalent to LTS", security fixes only). Upstream ships several stables a week.
- Options: A track `latest` stable, re-vet each bump / B track `extended-stable` for firms, `latest` in ring 0 only / C pin forever
- Decision: Develop and run the M1 lab on 2026.11.6 (`release.config.json`, `release/openclaw/package-lock.json`). Proposed for production (decide before M11): B, firms on `extended-stable`, each bump re-verified in OPENCLAW_NOTES.md and shipped through ring 0 like any release. Runtime Node: 24.22.3 LTS (`engines` `>=24.16.0 <25 || >=26.1.0`; 24.22.1+ strongly recommended). Payload install: `npm ci --omit=dev --ignore-scripts` from the Windows-generated lockfile (it includes the `@openclaw/fs-safe-win32-x64-msvc` prebuild, so OpenClaw's postinstall repair is not needed), then a `--version` smoke test with the bundled Node.
- Consequences: Plugin APIs are "experimental"; every OpenClaw bump is its own change with plugin tests. If plugin APIs we use are missing in extended-stable, B costs about a month of features.
- Depends on: L1 (runs from a read-only Program Files install)

## ADR-020: Gateway port leases must account for derived ports
- Date: 2026-11-22
- Status: Proposed (depends on L1 port inventory)
- Context: A gateway binds base+1 (MCP Apps, opt-in), base+2 (browser control; `browser` plugin on by default) and base+9…+110 (browser CDP). Upstream advises ≥120 ports between gateways. ARCHITECTURE §4 leases adjacent ports in 18800–19799 (OPENCLAW_NOTES.md §3).
- Options: A stride 120 (only ~8 gateways fit the range) / B deny the `browser` plugin, keep `mcp.apps.enabled` off, lease single ports, refuse to run if the gateway's process tree listens anywhere else / C lease a block per employee and set every derived port explicitly
- Decision (recommended): B, with the listener check in Desk at gateway start (and in the Server Agent's audit). Fall back to C if L1 finds other listeners.
- Consequences: No browser automation inside OpenClaw (portal downloads would need a separate, reviewed tool later).
- Depends on: L1

## ADR-021: Desk talks to its gateway from the Rust side with the full device-auth handshake; loopback rate limiting on
- Date: 2026-11-22
- Status: Proposed (option A implemented 2026-11-23 in `apps/desk/src-tauri/src/gateway_client.rs`; client.id/mode and session key still wait on L2)
- Context: Gateway WS needs token auth plus an Ed25519 device identity signing `connect.challenge`; `client.id` is a closed enum; browser-origin connects are origin-checked and get no local pairing (a Tauri WebView origin likely fails); a shared token is full `operator.admin`; `gateway.auth.rateLimit.exemptLoopback` defaults to true, and on an RDS host every user is "loopback", so token guessing would be unlimited (OPENCLAW_NOTES.md §3).
- Options: A implement protocol v4 in Desk's Rust side (no Origin header) / B a small Node sidecar embedding `@openclaw/gateway-client` 2026.11.6 / C `@openclaw/gateway-client/browser` in the WebView with an allowlisted origin
- Decision (recommended): A (B if A proves slow to build). Whatever the option, always: `exemptLoopback: false`, `controlUi.enabled: false`, `terminal.enabled: false`, protocol pinned to 4, device key DPAPI-protected per user, 256-bit random token per lease.
- Consequences: More Rust in M4; no Node sidecar per session. Which `client.id`/`mode` to use is still open (lab L2).
- Depends on: L2

## ADR-022: Access denied: tool-result middleware + before_tool_call gate + Desk aborts the run
- Date: 2026-11-22
- Status: Proposed (depends on L3)
- Context: ARCHITECTURE F5 assumed the guard's after-call hook converts EACCES into `access_denied` and stops the turn. Verified false: `after_tool_call` is observe-only, plugins have no API to abort a run, tool errors reach the model as text only, Node maps Win32 error 5 to `EPERM`, and `exec` reports denials as output (OPENCLAW_NOTES.md §5).
- Options: A `api.registerAgentToolResultMiddleware` rewrites EPERM/EACCES/"Access is denied" results to a fixed ACCESS_DENIED text and marks the run; `before_tool_call` blocks every further tool call in that run; the guard tells Desk over the pipe; Desk sends `chat.abort {sessionKey, runId}` / B pre-check in `before_tool_call` (`fs.access` as the user on `event.derivedPaths`/params) / C soft stop (tell the model to stop)
- Decision (recommended): A + B. The classifier is `packages/openclaw-plugins/guard/src/access-denied.ts` (already matches EPERM/EACCES/HRESULT/"Access is denied"). Manifest declares `contracts.agentToolResultMiddleware: ["openclaw"]`.
- Consequences: The hard stop needs Desk connected; for Telegram turns the Server Agent issues the abort (ADR-023).
- Depends on: L3

## ADR-023: Telegram v1 via the Server Agent as a gateway client, not a channel plugin
- Date: 2026-11-22
- Status: Accepted: option B (Dwahnil, 2026-11-22: "do everything": recommended option accepted; revisit any time)
- Context: A load-path channel plugin can replace the built-in Telegram channel (`plugins.deny: ["telegram"]`), but the channel SDK is large and marked experimental (inbound dispatch via `channelRuntime.inbound.*`; template `extensions/qa-channel`, 2.3k lines) (OPENCLAW_NOTES.md §6).
- Options: A own channel plugin (`channel-relay`, original plan) / B the Server Agent, which already leases the gateway's port and token, connects as a gateway client: `chat.send` on a dedicated Telegram session key, reads the `chat` final event, sends the text to Telegram; the guard recognises Telegram turns by session key and applies Telegram policy / C built-in Telegram channel with one bot per employee
- Decision (recommended): B for v1. Keep `packages/openclaw-plugins/channel-relay` as a placeholder; revisit A if native inline buttons or approvals inside OpenClaw are needed.
- Consequences: Much less code; no dependency on the experimental channel SDK. The Server Agent implements the gateway client protocol in Go (same design as ADR-021).
- Depends on: ADR-021, L6

## ADR-024: Skills and installs locked down in layers (no single switch exists)
- Date: 2026-11-22
- Status: Proposed (parts depend on L1)
- Context: Workspace, managed, personal and workshop skill roots all outrank `skills.load.extraDirs`; Skill Workshop is `auto` by default and the agent can write `<workspace>/skills/*`; there is no `clawhub.enabled` switch (OPENCLAW_NOTES.md §7).
- Decision (recommended): generated config sets `skills.load.extraDirs: [current\skills]`, `skills.allowBundled: []`, `agents.defaults.skills: [<our skill names>]`, `skills.workshop.autonomous.mode: "off"`; `tools.deny` includes `skill_workshop`, `plugins`, `openclaw`, `gateway`, `terminal`, `browser`, `nodes`; `commands.{plugins,config,restart}: false`; env `OPENCLAW_CONFIG_READONLY=1`, `CLAWHUB_DISABLE_TELEMETRY=1`, `OPENCLAW_NO_AUTO_UPDATE=1`, `DO_NOT_TRACK=1`; guard `before_install` returns `block: true`; `security.installPolicy` set to block; guard blocks writes into any skill root; Desk/Server Agent removes unexpected skill directories before each gateway start.
- Consequences: Defence in depth; each layer gets a test in M5/M7. Unverified: whether READONLY blocks `skills install` (L1).
- Depends on: L1

## ADR-025: Update = back up state, doctor, switch; rollback = restore the backup
- Date: 2026-11-22
- Status: Accepted: option A (Dwahnil, 2026-11-22: "do everything": recommended option accepted; revisit any time)
- Context: Migrations run via `openclaw doctor --fix --yes --non-interactive` with the gateway stopped; with `OPENCLAW_CONFIG_READONLY=1` config repairs are only printed as a patch; downgrading after a migration is unsupported (OPENCLAW_NOTES.md §8).
- Options: A before Doctor, snapshot the user's `openclaw-state` (or `openclaw backup create --verify`) into `backups\`; rollback restores that snapshot with the old version / B forward-fix only
- Decision (recommended): A. Our config generator applies Doctor's printed config patch itself.
- Consequences: Rollback loses what the user did after the switch (chats since the update); disk cost per user per update.

## ADR-026: No file-server work while the employee is logged off in v1
- Date: 2026-11-22
- Status: Accepted: option C for v1 (Dwahnil, 2026-11-22: "do everything": recommended option accepted; revisit any time)
- Context: OpenClaw's own Scheduled Task uses S4U, which "does not provide Windows network credentials": a logged-off gateway can't read `\\fileserver\Clients` even with correct NTFS rights (OPENCLAW_NOTES.md §2). F4.6 and F7.3 assumed it could.
- Options: A Password-logon task (store each employee's Windows password: DPAPI/LSA burden, breaks on password change) / B logged-off Telegram answers only from local, non-file-server data and says "Log in to Desk for client files" / C no logged-off gateways in v1 (Telegram replies "Open Desk to use Off Manual")
- Decision (recommended): C for v1, B as the first extension; A only with explicit firm consent.
- Consequences: Telegram works only while the employee has an RDP session (disconnected-but-logged-on sessions still count). Simplifies L5/L6.
- Depends on: L5, L6

## ADR-027: The guard protects against the agent, not against the employee
- Date: 2026-11-22
- Status: Accepted: A + B now, C later (Dwahnil, 2026-11-22: "do everything": recommended option accepted; revisit any time)
- Context: The gateway runs as the employee, so the employee can edit their own config, start their own OpenClaw, or read the LLM key from the gateway's environment.
- Options: A accept and document / B config in a ProgramData path read-only to the user + `OPENCLAW_CONFIG_READONLY=1` + Server Agent probes the gateway's plugin inventory over the leased connection / C LLM calls proxied through the Server Agent so the provider key never sits in a user process
- Decision (recommended): A + B now; C considered for M9/M11 (it also enables Off Manual's metered-key mode from ADR-011 without exposing the key).
- Consequences: SECURITY.md gains "employee tampers with own gateway". Skill packs are a safety boundary for the agent, not a security boundary against a determined employee; Windows rights remain the real file boundary.

## ADR-028: The guard owns the review queue; Lobster not used for it
- Date: 2026-11-22
- Status: Accepted (Dwahnil, 2026-11-22: "do everything": recommended option accepted; revisit any time)
- Context: With Lobster the agent itself can resume an approval with the token, pending items can't be listed, and there is no human-only gate; plugin approvals (`requireApproval`) are synchronous and capped at 10 minutes; `before_tool_call` can't return a synthetic success (OPENCLAW_NOTES.md §5, §9).
- Decision (recommended): listed actions are blocked in `before_tool_call` with `blockReason` "Queued for review #<id>"; the guard persists the proposal (`review.db`); Desk shows it; on approval the guard (not the agent) executes it. `requireApproval` only for immediate yes/no prompts.
- Consequences: More guard code in M5; no dependency on `@openclaw/lobster`. SKILLS.md §3 drops Lobster from the starter pack.

## ADR-029: Server Agent pipe uses an explicit-rights DACL, first-instance flag and server identity check
- Date: 2026-11-22
- Status: Accepted (security tightening; confirm on Server 2022 in L7)
- Context: ARCHITECTURE §3.1 said "Authenticated Users read/write". `FILE_GENERIC_WRITE` includes `FILE_CREATE_PIPE_INSTANCE`, so any logged-on user could create an instance of `\\.\pipe\offmanual-agent` and receive other users' Desk/guard traffic (PINs, TOTP codes) if the service is down or restarting. The lab L7 self-test on Windows 11 showed it: with the generic-write DACL a second account created a pipe instance; with `0x0012008B` (FILE_GENERIC_READ | FILE_WRITE_DATA) it got Win32 error 5. Microsoft Learn "Named Pipe Security and Access Rights".
- Options: A keep generic read/write / B explicit rights for Authenticated Users (`FILE_GENERIC_READ | FILE_WRITE_DATA`), SYSTEM full; `FILE_FLAG_FIRST_PIPE_INSTANCE` on the first instance; `PIPE_REJECT_REMOTE_CLIENTS`; clients check that the server process is LocalSystem before sending anything
- Decision: B. Caller identity stays OS-derived (rule 4): `GetNamedPipeClientProcessId` → process token SID + session ID; impersonation fails at `SECURITY_ANONYMOUS` (L7: OpenThreadToken error 1347), so the process-token method is primary.
- Consequences: Squatting needs SYSTEM. Desk and the guard implement the server check (`GetNamedPipeServerProcessId` → token SID S-1-5-18). M2 pipe package gets tests for both.
- Depends on: L7

## ADR-030: TOTP parameters and replay protection
- Date: 2026-11-22
- Status: Accepted
- Context: ADR-006 makes TOTP mandatory and verified locally by the Server Agent; parameters weren't fixed.
- Options: A SHA-1 / 6 digits / 30 s (what every authenticator app supports) / B SHA-256 or 8 digits (several apps ignore these URI parameters and show wrong codes)
- Decision: A, with ±1 step tolerance and replay protection: the highest accepted step is stored per employee (`totp_last_counter`) and any code at or below it is refused. 160-bit random secrets. Comparison is constant-time and checks every window step. HMAC-SHA-1 is not affected by SHA-1 collision attacks. Code: `apps/server-agent/internal/auth/totp.go`, checked against RFC 4226/6238 vectors.
- Consequences: A code typed for the daily unlock can't be reused for step-up within the same 30 s; Desk asks for the next code (plain message).

## ADR-031: PIN rules and argon2id parameters
- Date: 2026-11-22
- Status: Accepted
- Context: DATA_MODEL §2 stores `pin_hash (argon2id)`; length, weak-PIN policy and cost parameters weren't set. PINs unlock only after idle (F3) and three wrong PINs force the daily code, so online guessing is capped at 3 tries per daily-code cycle.
- Options: A 4–8 digits, refuse repeated/sequential/common PINs, argon2id m=64 MiB t=3 p=2 / B 6 digits fixed (more friction for article assistants) / C bcrypt (weaker against GPU cracking of a stolen agent.db)
- Decision: A. Hashes are PHC strings (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`); decoding bounds the parameters (8 MiB–1 GiB, t 1–20) so a tampered row can't request absurd work; verification reports "needs rehash" when stored parameters are weaker than current. Code: `apps/server-agent/internal/auth/pin.go`, `lockout.go`.
- Consequences: About 64 MiB and a fraction of a second per PIN check on the server; fine at a few checks per employee per day. Revisit if an RDS host shows contention (L1 RAM numbers).

## ADR-032: Server Agent libraries: modernc.org/sqlite and Microsoft go-winio
- Date: 2026-11-22
- Status: Accepted
- Context: M2 needs SQLite and an overlapped-I/O named-pipe server on Windows without a C toolchain in the build.
- Options: SQLite: A modernc.org/sqlite (pure Go, transpiled SQLite) / B mattn/go-sqlite3 (cgo; needs gcc in CI and release). Pipes: A github.com/Microsoft/go-winio (overlapped I/O, deadlines, SDDL, FILE_CREATE first instance, always FILE_PIPE_REJECT_REMOTE_CLIENTS; used by Docker and containerd) / B own CreateNamedPipe code with synchronous handles (cancellation and shutdown are fragile)
- Decision: A and A. Caller identity uses x/sys/windows `GetNamedPipeClientProcessId` → `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` → `OpenProcessToken(TOKEN_QUERY)` → `GetTokenUser`, plus `ProcessIdToSessionId`, on the accepted connection's handle (`Fd()`).
- Consequences: `CGO_ENABLED=0` builds keep working; the race detector runs only on Linux CI. Dependencies: golang.org/x/crypto, golang.org/x/sys, modernc.org/sqlite (+ runtime), go-winio, all tracked by dependabot.

## ADR-033: Server Agent data folder, secret storage and unlock windows
- Date: 2026-11-22
- Status: Accepted
- Context: M2 handlers need concrete rules for where secrets live, how long a daily unlock lasts and how step-up grants are kept. Lab L10 shows LocalMachine DPAPI blobs are decryptable by any local account that can read them.
- Decision: (1) `C:\ProgramData\OffManual` gets DACL `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)` at install (and on every start when running as SYSTEM); users never read it directly, only through pipe methods. (2) TOTP secrets: DPAPI LocalMachine + app entropy `offmanual-server-agent/secrets/v1`; empty secrets refused. (3) Daily unlock lasts until the next 22:00 IST (firm setting `working_day_hours` replaces this in M3). (4) Step-up grants are in-memory, 10 minutes, bound to SID + action class; a service restart clears them (fail closed). (5) Gateway tokens are 256-bit, returned once, stored as SHA-256. (6) TOTP enrolment is two-step: an unconfirmed secret can never unlock (`totp_enrolled_at`).
- Consequences: Admins on the server can read agent.db (they can anyway); ordinary users cannot. Revisit the 22:00 default with the pilot firm.

## ADR-034: Pipe clients request exact rights; Node clients use `server-agent bridge`
- Date: 2026-11-22
- Status: Accepted (refines ADR-029; does not weaken it)
- Context: The first CI run of the installed service showed that a standard named-pipe client (.NET `NamedPipeClientStream`, Node/libuv `net.connect`) opens with GENERIC_READ | GENERIC_WRITE, and GENERIC_WRITE maps to FILE_GENERIC_WRITE, which includes FILE_APPEND_DATA = FILE_CREATE_PIPE_INSTANCE. ADR-029 withholds that right from users to stop squatting, so such clients are refused. libuv (Node) only falls back to read-only or write-only opens, never read + write-data.
- Options: A relax the DACL to generic read/write for Authenticated Users and rely only on clients checking the server identity (weakens ADR-029; needs a security sign-off) / B keep the DACL; every client opens with exactly 0x12008B; Rust Desk does so natively; Node gets a stdio relay (`server-agent.exe bridge`) that opens the pipe correctly and checks the server is LocalSystem
- Decision: B. `pipe.Dial` = `winio.DialPipeAccess(name, 0x12008B)` at SECURITY_ANONYMOUS (the server can't impersonate clients). `server-agent bridge` relays NDJSON both ways, waits for outstanding replies on stdin EOF, refuses non-LocalSystem servers. CI asserts a GENERIC_WRITE client is refused even when running as Administrator, and that the bridge works against the real LocalSystem service.
- Consequences: One small bridge process per running gateway (the guard spawns it once). Desk must use CreateFileW with the exact access mask (M4). Lab L7 still confirms behaviour with two non-admin users on Server 2022.

## ADR-035: Agent request signature format
- Date: 2026-11-22
- Status: Accepted (makes ADR-013 concrete; ADR-013 → Accepted)
- Context: ADR-013 chose ed25519-signed requests but not the exact bytes; Go (agent) and TypeScript (console) must agree byte for byte.
- Decision: canonical string `OM-AGENT-1\n<METHOD upper>\n<path with query>\n<server id>\n<unix seconds>\n<nonce hex>\n<hex sha256 of raw body>`; headers `X-OM-Server`, `X-OM-Timestamp`, `X-OM-Nonce`, `X-OM-Signature` (base64). Console order of checks: header shape (400) → |skew| ≤ 300 s → key lookup (enrolled, not revoked) → signature → nonce unused within the window (stored until ts+300 s). A golden vector with a fixed TEST seed lives in `packages/shared-schema/fixtures/agent-signature.json`; both test suites must reproduce it exactly.
- Consequences: Servers need roughly correct clocks (preflight warns at 2 min). Nonce storage needs a Postgres table with expiry in production (M3).

## ADR-036: Console data and enrolment conventions
- Date: 2026-11-22
- Status: Accepted
- Context: First console tables and agent routes (M3) need fixed conventions.
- Decision: (1) Drizzle schema in `apps/console/db/schema.ts`, migrations generated by drizzle-kit and applied by a deploy-time script, never at request time. (2) Tests use PGlite (Postgres in WASM) with the real migrations, so SQL is exercised without a server. (3) uuidv7 IDs; servers appear on the wire as `srv_<32 hex>`. (4) Enrolment: one-time codes stored only as sha256 of the upper-cased code, 24 h expiry, consumed in a row-locked transaction; the request is signed by the key being enrolled (proof of possession, `X-OM-Server: srv_enrollment`). (5) Agent route handlers are pure `(deps, Request)` functions; `app/api/agent/*/route.ts` only wire production deps. (6) Policy responses carry an ETag derived from policy version, employee count/updated time and grant count; 304 when unchanged.
- Consequences: No database server needed for CI. Code generation in the console admin UI must show the code once and store only the hash.

## ADR-037: Console sign-in: OIDC + mandatory TOTP, server-side sessions
- Date: 2026-11-22
- Status: Accepted
- Context: M3 needs sign-in for superadmin/staff and firm admins; rule 9 makes TOTP mandatory; DATA_MODEL has no password columns.
- Options: A Auth.js (NextAuth) with an MFA add-on / B own thin layer: openid-client for OIDC + own TOTP and sessions / C passwords + TOTP
- Decision: B. Google and Microsoft Entra via openid-client v6 (discovery, PKCE S256, state, nonce; email must be verified, Entra work accounts count as verified). The verified email must match exactly one active console user or firm admin (an email admin for two firms is refused as ambiguous). Session cookie `om_session`: 32 random bytes, HttpOnly, SameSite=Lax, Secure in production; DB stores only sha256. A new session is pre-MFA (10 min, no access to anything but the TOTP API); a correct TOTP code upgrades it to 12 h. TOTP secrets are AES-256-GCM sealed with `OM_DATA_KEY`, AAD = column name; codes single-use via `totp_last_counter`. Authorisation helpers `requireConsole(roles)` and `requireFirmAccess(firmId)` are called by every handler.
- Consequences: Small, testable code (38 tests on PGlite with a fake IdP); no passwords to leak. Needs Google and Microsoft OAuth apps with redirect URIs `<OM_CONSOLE_URL>/auth/callback/{google,microsoft}` (PROGRESS.md "Waiting on Dwahnil").

## ADR-038: Billing calculation rules
- Date: 2026-11-23
- Status: Accepted
- Context: BILLING.md leaves some arithmetic choices open; invoices must be reproducible to the paisa.
- Decision: (1) All amounts bigint paise; rounding half away from zero, once per line (and once per tax). (2) Prorated seats are the exact fraction Σ enabled seat-days / days in month; peak_active is the integer maximum of daily active employees. (3) Volume bands pick the band by the seat count rounded up, then charge the exact fraction at that rate; tiered bands charge each band's share of the fractional quantity. (4) Monthly recurring lines prorate by days covered when a line starts or ends mid-month; quarterly/yearly lines bill in full in the month their interval starts, counted from `starts_on`. (5) Contract versions are expressed as lines with non-overlapping `starts_on`/`ends_on`; seat days are counted under the line whose dates contain them. (6) Adjustments apply after all other lines: `pct` is a percentage of their sum, `amountPaise` a fixed amount; the taxable total never goes below zero (excess credit is carried by hand). (7) Usage bills (tokens − included)+ × rate per 1M × (1 + markup). (8) GST: same state → CGST and SGST each at half the rate, else IGST, each rounded to the paisa. (9) Ladder: days past due of the oldest unpaid invoice: >0 overdue, > grace_days restricted, > suspend_after_days suspended; an override needs a reason and may expire.
- Consequences: Deterministic invoices; the CA should confirm SAC codes and rounding before invoices leave draft (BILLING §2).

## ADR-039: Skills enter the registry as "pending" until a human approves them
- Date: 2026-11-23
- Status: Accepted
- Context: SKILLS.md requires a human approval for every skill. Claude can write and vet skills but must not record an approval on Dwahnil's behalf; CI still has to hash-check what is in the repo.
- Decision: `registry.lock.json` review status is `pending` or `approved`. Pending skills are hash-checked like any other (unlisted or changed files fail CI) but the release workflow copies only approved skills and writes a payload lock containing only them. Approval = Dwahnil (with the firm's CA for tax content) sets status, reviewer and date. `tools/skill-vet lock` always emits `pending`.
- Consequences: Skills can be developed and reviewed in the repo without risk of shipping unreviewed instructions.

## ADR-040: Telegram relay details
- Date: 2026-11-23
- Status: Accepted (session key format pending lab L2)
- Context: ADR-023 chose the Server Agent as a gateway client for Telegram. It needs the gateway token (only a hash was stored), a device identity for the v4 handshake, and a session to run Telegram turns in.
- Decision: (1) `gateway.lease` also stores the token DPAPI-protected (`leases.token_dpapi`). (2) The Server Agent has one persistent relay device key (DPAPI, meta `relay_device_key_dpapi`); `client.id` `gateway-client`, mode `backend`. (3) Telegram turns use session key `agent:main:telegram`; the guard treats any session key containing `:telegram` as the Telegram channel. (4) The relay only connects to a gateway with a lease seen in the last 12 hours (Desk started it); otherwise it replies "Open Off Manual Desk…" (ADR-026). (5) Replies are sent as plain text (no parse mode), split at 4096 characters; incoming files are refused without download unless the firm mode is `files`. (6) The bot token is entered on the server (`server-agent telegram-setup`, read from stdin) and never sent to the console.
- Consequences: One relay identity per server needs pairing approval once per gateway (auto-approved for local connections per OpenClaw defaults; confirm in lab L2).

## ADR-041: Review queue uses guard proposal tools, executed by the guard on approval
- Date: 2026-11-23
- Status: Accepted (refines ADR-028; runtime registration pending lab L-guard)
- Context: ADR-028 planned to block listed built-in calls in `before_tool_call` and later have the guard execute them. Verified in 2026.11.6: a plugin has no in-process way to invoke a tool, and `/tools/invoke` hard-denies exactly the risky tools (`exec`, `fs_delete`, `apply_patch`, …). A blocked call also reads to the model as a failure, not a queued request. Raw shell commands are also not something a partner can meaningfully review.
- Options: A block built-ins + replay via `/tools/invoke` (doesn't work for the tools that matter) / B guard-owned proposal tools whose `execute` only stores a proposal; the guard runs the stored, validated action itself on approval; built-in deletes blocked with a pointer to the tool / C `requireApproval` prompts (synchronous, ≤ 10 min, no list)
- Decision: B. Store is `review.json` under the guard's state dir (no SQLite dependency inside the gateway; tiny data). Decisions come only through gateway methods `offmanual.review.list|decide` with scope `operator.approvals`; the agent can't reach them (`gateway` tool denied). Each approval is claimed atomically and runs once; an item found mid-execution at startup is marked failed, never re-run. Edits are re-validated by the action's parser. v1 action: `delete_files` (absolute or UNC files, ≤ 50, no folders, no wildcards). Tally voucher and client email become further actions in their packs.
- Consequences: Every irreversible capability Off Manual adds must be a proposal action (SKILLS.md packs list them). The delete-pattern block on built-ins is a heuristic (defence in depth), not the guarantee; the guarantee is that our own irreversible actions only exist as proposals and Windows rights bound everything else (rule 2).

## ADR-042: Licence enforced on the server from synced firm status, fail closed
- Date: 2026-11-23
- Status: Accepted
- Context: BILLING §6 defines the ladder and a 7-day offline grace; the console sends `firmStatus` with every heartbeat reply. Employees reach the assistant through Desk (guard `before_agent_run`) and Telegram (Server Agent relay).
- Options: A guard reads firm status itself / B Server Agent derives one licence result and serves it inside `lock.get` (one round trip, already cached ≤ 5 s by the guard) and to the Telegram router
- Decision: B. Rules: never synced or no contact time → not activated (paused); `suspended`/`closed` → paused; unknown status or unparseable time → paused (fail closed); last contact older than 7 days → paused (offline); `overdue`/`restricted` → usable with a notice; `trial`/`active` → usable. The licence check runs before every lock rule, so a Telegram unlock window doesn't bypass it. The grace is a constant (7 days) until contracts carry `offline_grace_days` to the server.
- Consequences: A new server is unusable until its first successful heartbeat (expected: enrolment does one). Firm admins are paused too in v1 (BILLING says Desk opens for admins only); needs admin identity on the server.

## ADR-043: Pack → tool definitions ship in the signed release; the guard allowlists tools per employee
- Date: 2026-11-23
- Status: Accepted
- Context: Packs decide what each employee's assistant can do (PRODUCT, SECURITY: "skill packs limit tools"). The console has a `skill_packs` table with an `actions` list, but a compromised or mistaken console could then widen what runs on a client server, and skills (which name their packs) already ship in the signed release.
- Options: A pack definitions from the console policy / B `skills/packs.json` in the signed release, console grants only pack keys
- Decision: B. The guard loads packs.json (path from Desk's plugin config) and, in `before_tool_call`, allows a tool only if a granted pack lists it; packs come from `policy.get` (cached 30 s). No pack file or no policy → every tool call refused (fail closed). Telegram turns get `core` plus the firm's `telegramAllowedPacks` intersected with the employee's packs. Tool names are normalised (lower case, `bash` → `exec`). `verify-skills` validates packs.json and that every skill's packs exist.
- Consequences: Adding a tool to a pack needs a release (deliberate). Every tool the agent needs must be listed in some pack, or it is refused; internal OpenClaw tools that turn out to be needed get added after lab L-guard. The console's `skill_packs.actions` becomes display-only.

## ADR-044: Employee binding by a code shown after console sign-in and typed into Desk
- Date: 2026-11-23
- Status: Accepted
- Context: F2 needs the console to learn which Windows account (SID) belongs to which invited employee. Desk can't receive an OAuth redirect itself, and anything that carries a nonce from Desk through a browser link can be phished: a victim who signs in through an attacker's link would bind their employee record to the attacker's SID.
- Options: A Desk nonce in the console URL, console binds on sign-in / B console shows a one-time code after the employee's own sign-in; the employee types it into Desk; the Server Agent redeems it with the OS-derived SID
- Decision: B. Employee sign-in reuses the console OIDC client (verified email required) but creates no console session. One live code per employee (8 characters, no look-alikes, 10 minutes, stored as a hash). Redemption is a signed agent request, in one transaction: unknown, used, expired and other-firm codes get the same answer; an employee whose SID is already set (AD import or earlier binding) only re-binds the same SID; a SID can't belong to two employees in a firm; after the first binding the same OIDC subject must be used. The agent limits bindComplete to 10 tries per SID per hour and records the employee locally at once.
- Consequences: The employee types one code (shown with a phone QR for convenience). Resetting a binding is an admin action (to build). Recovery codes and invite emails remain to do.

## ADR-045: Billing storage and run: engine specs in jsonb, drafts refreshed until issued, ladder writes firm status
- Date: 2026-11-23
- Status: Accepted
- Context: ADR-038 made the billing maths pure. Storing it needs: contract lines in a shape the engine trusts, an idempotent monthly run, gap-free numbering per FY, and the ladder feeding the status the Server Agent enforces (ADR-042).
- Decision: Contract lines are stored as the engine's `ContractLine` in jsonb (paise as decimal strings) and validated strictly on read and on save; a line is clipped to its contract version's end date so mid-month changes prorate by version. One invoice per firm and month (unique); the run replaces a draft's lines in place and never touches issued/paid/void invoices. Numbers are assigned only on issue from `invoice_counters` inside the issuing transaction (no gaps from deleted drafts); issuing is refused until `OFFMANUAL_GSTIN` is configured (BILLING §2: drafts only until the CA confirms). Seat activity for `peak_active` = at least one turn that day in `usage_daily`. `refreshFirmStatus` computes the ladder from issued invoices with the contract's grace and suspend days plus the newest unexpired override (reason required) and writes `firms.status`; trial firms without a contract and closed firms are untouched.
- Consequences: A scheduler (cron route) still has to call `runMonth` on the 1st and `refreshFirmStatus` daily; PDF and Razorpay come next. Credit notes for issued invoices are manual until built.

## ADR-046: Recovery codes reset the authenticator from the employee's own session
- Date: 2026-11-23
- Status: Accepted
- Context: F2 step 4 promises recovery codes. TOTP is mandatory (rule 9), so a lost phone otherwise needs an admin.
- Decision: On authenticator confirmation the Server Agent creates 8 codes (`XXXXX-XXXXX`, no look-alike characters, ~49 bits each), returns them once and stores only `sha256("om-recovery:" + normalised code)`. `auth.recover` takes one code from the caller's own (OS-identified) session, at most 5 tries per hour per SID; a correct code is consumed atomically, the TOTP secret/enrolment/counter are cleared and the day grant revoked, so the employee enrols the new phone (and gets fresh codes) before anything unlocks. Codes are case and dash insensitive.
- Consequences: Someone who has both the employee's Windows session and a recovery code can re-enrol; that is the same trust as the Windows password plus a secret the employee keeps offline. An admin reset path is still needed for employees who lose the codes too.
