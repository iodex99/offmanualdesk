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
- Status: Proposed
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
- Status: Proposed
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
