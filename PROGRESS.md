# Progress

<!-- Claude Code: keep this file short enough to scan in 30 seconds. Newest session log entry first. Move finished milestones' detail into the Done summary when they are complete. -->

## Current focus

M0 and M2 done and on `main`. M3 console (auth, agent API, management API, fleet) and the starts of M4 Desk and M5 guard are on `main` too; work continues on branch `m4-desk`. M1 waits on Dwahnil's lab run and decisions on Proposed ADRs.

## Next step

1. Branch `m4-desk` (merge to `main` when CI is green). Remaining M3: console auth (superadmin/staff/firm admin, mandatory TOTP; OAuth needs Dwahnil's Google/Microsoft apps, so build with an injectable provider and test with fakes), firm/server/employee/invite management + enrolment-code creation, employee OAuth → SID binding endpoint, fleet board v0. `gh` is logged in (`C:\Program Files\GitHub CLI\gh.exe`).
2. When lab output arrives: `/lab-result L<n>` for each; promote/supersede ADR-019…029 accordingly; flip [A] markers in ARCHITECTURE.md.
3. Unblocked meanwhile (M2, recorded exception below): Server Agent SQLite store + migrations, JSON-RPC framing over a fake pipe, TOTP/PIN verification, port-lease allocator, all with fakes for Windows-only parts.

M2 may start before M1's lab boxes are ticked: lab results only affect pipe ACL details (ADR-029), port leasing (ADR-020) and logged-off gateways (ADR-026), which M2 isolates behind interfaces.

## Waiting on Dwahnil

- [x] GitHub repo: `https://github.com/iodex99/offmanualdesk` (created 2026-11-22; `main` + `m0-scaffold` pushed). Note the name has no hyphen; docs that say `offmanual-desk` mean this repo.
- [x] GitHub CLI installed (winget, 2026-11-22).
- [ ] Approve the `gh` login: open https://github.com/login/device and enter the code Claude gave you (new code needed if it expired: ask Claude to restart `gh auth login --web`).
- [x] Proposed product ADRs accepted on Dwahnil's "do everything" instruction (016, 019, 023, 025, 026, 027, 028); overturn any by saying so. Lab-dependent ADRs (020, 021, 022, 024) stay Proposed until L1–L3.
- [ ] **Lab VM** (M1): Windows Server 2022 VM with RDS Session Host, users labA/labB/labAdmin, `Clients` share, TallyPrime educational. Exact steps: `lab/README.md` §1. Then run the scripts in the order in `lab/README.md` and paste each output with `/lab-result L<n>`.
- [ ] **Release signing key** (needed for the first real release; a dry run works without it): on your machine run `go run ./tools/sign-manifest keygen -key-id om-rel-2026a -out-public apps/server-agent/pkg/manifest/keys/om-rel-2026a.pub -out-private %USERPROFILE%\om-rel-2026a.seed`; add the seed file's content as GitHub secret `RELEASE_SIGNING_KEY` and variable `RELEASE_KEY_ID=om-rel-2026a`; commit the `.pub`; delete the seed file (keep an offline backup).
- [ ] Optional for development: install Visual Studio 2022 Build Tools ("Desktop development with C++") so Desk's Rust code can compile locally; today only CI can.
- [ ] Later (M3+): Postgres database URL, Vercel project, Google OAuth client, Microsoft Entra app registration, Resend API key
- [ ] Later (M6): Telegram bot token for the lab firm
- [ ] Later (M8): Azure Trusted Signing account (or code-signing certificate) as GitHub secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` + variables `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_CERT_PROFILE`; release store (ADR-016) secrets `RELEASE_STORE_*`
- [ ] Later (M9): Razorpay test keys; Off Manual GSTIN, state, SAC code confirmed with the CA

## Milestones

### M0 Scaffold
- [x] Hook scripts tested on this machine (node 22.18, git 2.55); automated in `.claude/hooks/test/` (9 tests)
- [x] Monorepo layout per ARCHITECTURE.md § Repository layout
- [x] Hello-world build per app (Go service, Tauri app, Next.js console, two TS plugins)
- [x] Lint, format, type-check, test configured per app
- [x] `.gitignore`, `.env.example` per app (console has secrets; others have none yet)
- [x] CI: Go + Rust on windows-latest, console + plugins on ubuntu-latest (+ Go on Linux, lab parse, actionlint, gitleaks)
- [x] CLAUDE.md "Commands" section filled in
- [x] First CI run green on GitHub (run 45011292407, all 6 jobs) → `m0-scaffold` merged to `main` (fast-forward)

### M1 Research + lab spikes
- [x] OpenClaw version pinned (ADR-019: 2026.11.6, commit 06afb10d; Node 24.22.3)
- [x] OPENCLAW_NOTES.md §1–10 verified with links/paths
- [x] Assumptions that broke → Proposed ADRs (ADR-020…028; ADR-029 accepted)
- [x] `lab/` scripts for L1–L10 + `lab/README.md` runbook (parse clean on PS 5.1; L3/L7/L8/L9/L10 smoke-tested on Windows 11)
- [ ] Lab results recorded (needs Dwahnil) and ADRs updated
- [x] Product ADRs decided (016, 019, 023, 025–028); lab-dependent ones wait for results

### M2 Server Agent core (done 2026-11-23; merged to `main`)
- [x] Windows service install/uninstall/start/stop (SCM recovery: restart 5 s/30 s/2 min), `run` foreground mode, JSON logs to `logs\server-agent.log` (CI round trip on windows-latest)
- [x] SQLite local store + migrations (DATA_MODEL.md §2; `internal/store`, ADR-032)
- [x] Named pipe JSON-RPC server with OS-derived caller SID (ADR-029 DACL; `internal/rpc`, `internal/pipe`; DACL verified on a real pipe)
- [x] Method handlers (`internal/agent`): session.hello, auth.totpEnrolStart/Confirm, auth.verifyDaily, auth.pinSet, auth.verifyPin, auth.stepUp, lock.get/set, gateway.lease/release, audit.append, policy.get (defaults until M3)
- [x] Signed-request protocol (ADR-035): Go signer `internal/console/sign.go`, TS verifier `apps/console/lib/agent-auth.ts` (±5 min, nonce replay), shared golden vector
- [x] Enrolment (`server-agent enroll -console URL CODE`: preflight + proof-of-possession, key DPAPI-protected in meta) and 15-min sync loop: heartbeat, policy (ETag) into agent.db, offboarding of employees the console no longer lists, daily audit counts upload (`internal/console`)
- [x] Policy fetch → stored in agent.db meta (`policy_json`), served via `policy.get` (users never read files; ADR-033)
- [x] TOTP verification (RFC 6238, ±1 step, replay protection) in `internal/auth` (ADR-030)
- [x] PIN rules + argon2id hashing/verification, lockout rules (3 PINs → daily code; 5 codes → 15 min + admin alert) in `internal/auth` (ADR-031)
- [x] Lock state / attempts persisted in agent.db
- [x] Port lease storage: stable per employee, lowest free port, expiry (`store/leases.go`)
- [x] 256-bit gateway tokens, only SHA-256 stored; returned once to the caller
- [x] Audit log append + summary upload (category counts only)
- [x] Pre-flight check command (`server-agent preflight [-share] [-json]`: Windows version, RAM, disk, Remote Desktop, WebView2, TallyPrime, bundled Node, Clients share, outbound HTTPS + clock skew)
- [x] `server-agent bridge` for Node clients (ADR-034)

### M3 Console core
- [x] Auth for superadmin / staff / firm admin with mandatory TOTP (OIDC Google/Microsoft via openid-client, server-side sessions, encrypted TOTP secrets, role + firm scoping; ADR-037). Live sign-in needs Dwahnil's OAuth apps
- [x] Firms, enrolment codes, employees (+ invite records, offboarding), skill-pack grants (employee or `OM-*` AD group), firm policy: `lib/admin.ts` + JSON APIs `/api/admin/*` (session, strict input, CSRF guard, firm scoping)
- [ ] Invite delivery (Resend email; WhatsApp v2) and admin UI pages beyond the fleet board
- [x] Agent API v1: enroll, heartbeat, policy (ETag), audit-summary (`lib/agent-api.ts`, signed, strict bodies, PGlite-tested)
- [ ] Agent API: usage, releases, support bundle, notices, auth/bind
- [ ] Employee OAuth sign-in (Google, Microsoft) + SID binding endpoint
- [x] Fleet board v0 (`/fleet`: firm, server, health with 1 h staleness → red, last seen, version, seats)

### M4 Desk core
- [ ] Tauri shell, autostart at logon, single instance per session
- [x] Pipe client in Rust (`src-tauri/src/agent_client.rs`: CreateFileW with 0x12008B, SQOS anonymous, server must be LocalSystem, NDJSON, Desk method allowlist) + `agent_call` command
- [x] TOTP enrolment (QR) + PIN set screens (`ui/src/Unlock.tsx`)
- [ ] Sign-in + SID binding (needs console employee OAuth + bind endpoint)
- [x] Daily unlock, PIN unlock, switch to daily code after 3 wrong PINs, manual lock
- [ ] Idle lock timer, step-up prompt
- [ ] Gateway lifecycle: lease, start as user in a Job Object, health, stop on idle, restart (F4)
- [ ] Gateway client in Rust: protocol v4 + device auth (ADR-021)
- [ ] Docked chat panel + global hotkey
- [ ] Explorer right-click "Ask Off Manual"
- [ ] Notifications area (updates, billing, admin)

### M5 Guard plugin
- [x] Packaging + SDK typing: `openclaw.plugin.json`, `dist/plugin.js`, `before_install` block (M1)
- [x] Lock enforcement on every inbound turn (`before_agent_run` via `server-agent bridge`, 5 s cache, fail closed, Telegram window) 
- [ ] Licence (firm status) enforcement
- [ ] Skill packs from policy (AD groups + console overrides)
- [x] Access-denied handling in the guard (ADR-022: tool-result middleware rewrite + `before_tool_call` block for the rest of the run + audit event)
- [ ] Desk side: `chat.abort` + Request access button
- [ ] Review queue (ADR-028; approve all / edit / reject), Desk UI
- [x] Audit events to Server Agent (access denials)
- [ ] Telegram policy enforcement (off / text / files)

### M6 Telegram
- [ ] Server Agent long-polls firm bot, routes by linked Telegram user ID
- [ ] Relay: Server Agent as gateway client (ADR-023) or channel-relay plugin
- [ ] Link via deep link one-time code
- [ ] Unlock via Telegram (button + `/unlock <code>`)
- [ ] ~~Wake stopped gateway on message~~ out of v1 if ADR-026 is accepted

### M7 Skills
- [ ] Registry tooling: vendor, lock, scan, sign, build pack (`verify-skills` exists)
- [ ] Starter pack imported and reviewed (SKILLS.md §3)
- [ ] Client directory skill + admin scan
- [ ] Task buttons v1 (SKILLS.md §5)
- [ ] India pack v0 (SKILLS.md §4)

### M8 Updates
- [x] GitHub Actions release workflow (build, test, scan, sign, manifest, upload, register) — written and actionlint-clean; first run needs repo + signing key (done early at Dwahnil's request)
- [x] Manifest sign/verify/safe-extract library (`apps/server-agent/pkg/manifest`) + `tools/sign-manifest`
- [ ] Release store + console `/api/releases` (ADR-016)
- [ ] Rings + firm pins in console
- [ ] Server Agent stage + verify + report (embed `keys/*.pub`)
- [ ] Desk notice + restart-to-update + security deadline (backup → doctor → switch, ADR-025)
- [ ] Rollback (restore state backup, ADR-025)
- [ ] MSI (WiX v4) for first installs

### M9 Billing
- [ ] Contracts with versioned line items
- [ ] Monthly invoice run with GST split + PDF
- [ ] Razorpay (payment links, UPI AutoPay / e-mandate), webhooks
- [ ] Notification engine + Desk banners
- [ ] Enforcement ladder + manual override

### M10 Admin and ease
- [ ] Admin agent tools
- [ ] Setup wizard (pre-flight → import users → invites → client scan)
- [ ] Weekly partner digest
- [ ] Report a problem → support queue
- [ ] Fleet board v1

### M11 Pilot hardening
- [ ] Security review against SECURITY.md checklist
- [ ] Backup and restore of per-user agent state
- [ ] Firm-facing docs (employee quick start, admin guide)
- [ ] Install runbook, time-to-live under 2 hours verified

## Done summary

(empty)

## Session log

<!-- Format:
### YYYY-MM-DD HH:MM: <short title>
- Changed: …
- Files: …
- Tests: … (pass/fail)
- Half-done / next: …
-->

### 2026-11-23 00:30: Guard plugin enforcement (M5 start)
- Changed: `guard/src/agent-bridge.ts` (NDJSON JSON-RPC over `server-agent bridge` stdio; method allowlist lock.get/policy.get/audit.append; timeouts; restarts; fail closed), `gates.ts` (lockGate, LockCache, access-denied detection + replacement text, StoppedRuns, targetFromArgs), `plugin.ts` wired to `before_agent_run`, `registerAgentToolResultMiddleware`, `before_tool_call`, `agent_end`, `before_install`, service stop; manifest `bridgeCommand`.
- Tests: guard vitest 43/43 (3 consecutive runs) incl. a fake bridge process (junk lines ignored, error replies, bridge death → AgentUnavailable, restart, missing exe); typecheck against openclaw@2026.11.6 confirms hook names and payload fields; lint + build clean.
- Half-done / next: skill packs → tool allowlist, review queue (ADR-028), Telegram policy, Desk abort + Request access.

### 2026-11-22 23:45: Desk ↔ Server Agent client and unlock flow
- Changed: Rust `agent_client.rs` (windows-sys 0.61 FFI, paths verified in the crate source; `unsafe_code` lint now `deny` with one audited module), Tauri command `agent_call` on a blocking thread; UI `agent.ts`, `Unlock.tsx` (signup / enrol / PIN / unlock / ready), wired into `App.tsx`; `qrcode` dependency.
- Tests: desk vitest 8/8 (scripted fake agent: enrol, wrong PIN message, 3-strike switch to daily code, service down + retry); Rust unit tests for access mask, method allowlist, request/reply parsing (run in CI); cargo fmt clean locally. Rust compile/clippy only in CI.
- Half-done / next: idle lock + gateway lifecycle (lease → spawn OpenClaw in a Job Object, readiness, listener check), Explorer menu, hotkey, single instance.

### 2026-11-22 23:00: Console management API + fleet board
- Changed: `lib/admin.ts` (createFirm with default policy, listFirms scoped, one-time enrolment codes without look-alike characters, add/list/disable employees, pack grants by employee or AD group with ownership checks, policy updates with version bump, fleet with staleness), `lib/admin-routes.ts` (session + plain errors + JSON-only mutations), routes under `app/api/admin/*`, `/fleet` page. Postgres unique violations mapped by SQLSTATE 23505 (a test caught Drizzle's wrapped error).
- Tests: console vitest 50/50 (cross-firm attempts refused for list/add/disable/grant/policy; fleet staff-only); lint, typecheck, build clean; CI green on the auth slice.
- Half-done / next: M4 Desk core (Rust pipe client with exact access, sign-in/bind, unlock UI, gateway lifecycle), then employee bind endpoint on the console.

### 2026-11-22 22:30: Console sign-in with mandatory TOTP
- Changed: `lib/totp.ts` (RFC 6238, same params as agent), `lib/secretbox.ts` (AES-256-GCM, column-bound AAD, key `OM_DATA_KEY`), `lib/auth.ts` (principals by verified email, sessions with hashed tokens: pre-MFA 10 min / full 12 h, TOTP enrol/verify with replay counter, `requireConsole`, `requireFirmAccess`), `lib/oidc.ts` (Google/Entra via openid-client PKCE+state+nonce; email must be verified), `lib/auth-routes.ts` + routes `/auth/login/[provider]`, `/auth/callback/[provider]`, `/api/auth/totp`, `/auth/logout`; pages `/sign-in`, `/sign-in/totp` (QR enrolment). Migration 0001 (`sessions`, `totp_last_counter`). ADR-037. Vitest timeouts raised to 30 s (PGlite boot per test).
- Tests: console vitest 38/38 (stable over 4 runs); typecheck, lint, format, `next build` clean.
- Half-done / next: firm/server/employee management + enrolment-code UI, employee bind endpoint, fleet board.

### 2026-11-22 21:45: Console schema + agent API; agent enrolment and sync
- Changed: console: Drizzle schema for identity/tenancy/capabilities/releases/usage/audit/support + `agent_nonces` (migration `db/migrations/0000_*.sql`), uuidv7 + `srv_<hex>` public IDs, `lib/agent-api.ts` (enroll with proof of possession and single-use hashed codes, heartbeat, policy with ETag/304, audit-summary upsert), routes under `app/api/agent/*`, `scripts/migrate.mjs`, PGlite test harness. Agent: `internal/console` client + Syncer, `app.Enrol` + `server-agent enroll`, sync loop started by `Run` when enrolled, `policy.get` uses synced firm policy (unknown Telegram mode → off), store `EmployeeSIDs`/`DisableEmployee`/`ActiveLeases`. ADR-036.
- Tests: console vitest 20/20 on PGlite (signature, replay, skew, revoked, imposter key, cross-firm isolation in policy, unknown fields/client content refused); `next build` lists the 4 agent routes; Go all pass (console 77%, agent 76.6%); golangci-lint both OSes 0.
- Half-done / next: console auth + management UI.

### 2026-11-22 21:00: CI service round trip fixes
- Changed: CI on the real LocalSystem service confirmed GENERIC_WRITE clients are refused; the bridge timed out because PowerShell appends a blank line and the server sends no reply for blank lines. `lineCounter` (now in portable `pipe.go`, unit-tested) counts only non-blank request lines.
- Tests: pipe tests pass; golangci-lint linux clean.
- Lesson: never pipe a check through `tail` inside an `&&` chain: it hides the exit code.

### 2026-11-22 20:45: Agent ↔ console signed requests
- Changed: ADR-013 made concrete (ADR-035): canonical string `OM-AGENT-1\nMETHOD\npath?query\nserverId\nts\nnonce\nsha256(body)`, headers X-OM-Server/Timestamp/Nonce/Signature, ed25519. Go `internal/console/sign.go`; TS `apps/console/lib/agent-auth.ts` with clock window, nonce store (signature checked before the nonce is consumed). Golden vector `packages/shared-schema/fixtures/agent-signature.json` (test seed 1..32) verified by both; `.gitleaks.toml` allowlists that one file. Test caught a nonce-purge bug (wall clock vs request time), fixed.
- Tests: Go console pkg 89.5%; console vitest 12/12.
- Half-done / next: console DB schema + /api/agent routes (M3).

### 2026-11-22 20:15: M2 slice 5: preflight, bridge, pipe access fix
- Changed: CI's new service round trip found that a standard .NET pipe client (GENERIC_READ|GENERIC_WRITE) is refused by the ADR-029 DACL, which is correct (GENERIC_WRITE includes FILE_CREATE_PIPE_INSTANCE) but means every client must request exactly read + write-data. `pipe.Dial` now uses `DialPipeAccess(0x12008B)` at SECURITY_ANONYMOUS; new `pipe.Bridge` + `server-agent bridge` relays stdin/stdout for Node clients (guard) after checking the server is LocalSystem; CI now asserts a GENERIC_WRITE client is refused even for an admin and that bridge works against the real service. `internal/preflight` + `server-agent preflight`. Test pipe names made collision-proof. ADR-034.
- Tests: all Go → pass (preflight 81.8%); preflight run on this laptop reports correctly; golangci-lint windows + linux → 0 issues; actionlint clean.
- Half-done / next: confirm CI round trip green; M3 console.

### 2026-11-22 19:30: M2 slice 4: handlers, DPAPI, service
- Changed: `internal/secrets` (DPAPI machine scope + app entropy; in-memory AES-GCM fake for tests), `internal/agent` (13 pipe methods with plain-language errors, lockout, replay protection, day grant to 22:00 IST, step-up grants 10 min, leases), migration 0002 (`totp_enrolled_at`), `internal/app` (wiring, data dir + SYSTEM/Admins ACL, JSON logs), `cmd/server-agent` run/install/uninstall/service; CI job installs the service as LocalSystem on windows-latest, calls it over the real pipe and uninstalls. ADR-033.
- Tests: all Go → pass (agent 75.7%, app 76.1%, secrets 85.7%, store 85.7%); real DPAPI + real pipe + data-dir ACL on this box; golangci-lint windows + linux → 0 issues. Installing the service on Dwahnil's laptop was (rightly) blocked: CI covers it.
- Half-done / next: console (M3) for enrolment/heartbeat; preflight; Desk (M4) client.

### 2026-11-22 18:45: M2 slice 3: store, JSON-RPC, named pipe
- Changed: `internal/store` (SQLite via modernc.org/sqlite, embedded migration 0001, employees/day grants/lock state/audit summary/leases), `internal/rpc` (strict NDJSON JSON-RPC, caller from transport, plain errors + correlation IDs, no params in logs, 64 KiB cap, panic recovery), `internal/pipe` (go-winio listener with ADR-029 DACL, caller SID/session/PID from the client process token, ServerSID for clients, Dial); accepted product ADRs on Dwahnil's "do everything"; ADR-032.
- Tests: `go test` all Go → pass (store 84.6%, rpc 87.6%, pipe 81.0%, auth 94.9%); real Windows pipe tests on this box: caller identity correct over 3 connections, second listener refused, DACL = `D:P(A;;FA;;;SY)(A;;FA;;;<owner>)(A;;0x12008b;;;AU)`; golangci-lint (windows + GOOS=linux) → 0 issues.
- Half-done / next: handlers (agent package) + DPAPI wrapper + service wrapper + `run` command.

### 2026-11-22 18:00: CI fixes + M2 slice 2: PIN and lockout
- Changed: first CI run on GitHub: Desk Rust (fmt, clippy -D warnings, tests) passed first time on windows-latest; fixed 4 shellcheck findings in release.yml (only visible on the runner) and turned off gitleaks' SARIF artifact upload (account artifact quota full; scan itself found no leaks). M2: `internal/auth/pin.go` (PIN rules, argon2id PHC hashes, bounded decode, rehash flag), `lockout.go` (F3 rules), ADR-031; first Go dependency `golang.org/x/crypto` v0.59.0.
- Tests: `go test` server-agent + sign-manifest → pass (auth 94.9% cover); golangci-lint → 0 issues; sign-manifest builds with GOWORK=off.
- Half-done / next: confirm the re-run of CI on `m0-scaffold` is green, merge to `main`; then M2 store (SQLite) and lease allocator.

### 2026-11-22 17:30: M2 slice 1: TOTP verification
- Changed: branch `m2-server-agent` (from `m0-scaffold`); `apps/server-agent/internal/auth/totp.go` (HOTP/TOTP, Verify with skew + replay protection, secret generation, otpauth URI); ADR-030; DATA_MODEL §2 `employees.totp_last_counter`.
- Tests: `go test ./apps/server-agent/internal/auth/` → pass, 94.5% cover; all RFC 4226 + RFC 6238 (SHA1/256/512) vectors.
- Half-done / next: PIN hashing needs `golang.org/x/crypto/argon2` (first external Go dependency). CI review waits on `gh` login approval.

### 2026-11-22 17:00: Pushed to GitHub
- Changed: remote `origin` = https://github.com/iodex99/offmanualdesk.git; pushed `main` (kit) and `m0-scaffold` (13 commits).
- Tests: none new; first CI run triggered by the push.
- Half-done / next: review CI, fix, merge to `main`.

### 2026-11-22 16:30: M0 scaffold, M1 research + lab scripts, release pipeline
- Changed: moved the kit to the repo root, `git init`, local identity. M0: pnpm workspace (TS 6.0, ESLint 10, Prettier, Vitest 5), Go workspace (server-agent + sign-manifest), Tauri 2 Desk (React UI + Rust shell + icons, Cargo.lock), Next 16 console (health API), shared-schema (manifest/IPC JSON Schemas, ₹/date/FY helpers, golden fixture shared with Go), guard + channel-relay packages. Release manifest library (ed25519 over exact bytes, deterministic zip, zip-slip-safe extraction), `sign-manifest` CLI, `tools/release` (prepare/check-tag/notes/verify-skills). CI (`ci.yml`) and release (`release.yml`) workflows, dependabot, golangci config. M1: OpenClaw research (agent) → OPENCLAW_NOTES.md §1–10; pinned OpenClaw 2026.11.6 + Node 24.22.3 (`release.config.json`, `release/openclaw` lockfile); guard plugin given real packaging and typed against the SDK; ADR-015…029; ARCHITECTURE/SECURITY/UPDATES/SKILLS/LAB_VALIDATION updated; lab scripts L1–L10 + runbook (agent).
- Files: everything under apps/, packages/, tools/, lab/, release/, skills/, .github/, root configs; docs/*; DECISIONS.md; CLAUDE.md (Commands); .claude/hooks (lint fix + tests).
- Tests: `pnpm run check` → pass (Vitest 76: shared-schema 39, guard 30, desk 3, console 2, relay 2; hooks 9; release tools 10); `go test` server-agent + sign-manifest → pass (manifest 87.5% cover); golangci-lint → 0 issues; actionlint → clean; `next build` → ok; desk `vite build` → ok; `cargo fmt --check` → ok. NOT run locally: cargo clippy/test (no MSVC; GNU toolchain lacks dlltool), PSScriptAnalyzer (not installed); all lab scripts parse on PS 5.1 (0 errors).
- Half-done / next: push blocked on the GitHub repo; first CI run will be the first Rust compile. Lab run and ADR decisions waiting on Dwahnil.

### 2026-11-22: Kit created
- Changed: initial memory files, docs, hooks and skills from the Off Manual × OpenClaw plan.
- Next: BUILD_PROMPT.md §4.
