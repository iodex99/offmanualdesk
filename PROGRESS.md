# Progress

<!-- Claude Code: keep this file short enough to scan in 30 seconds. Newest session log entry first. Move finished milestones' detail into the Done summary when they are complete. -->

## Current focus

M1 Research + lab spikes: research and scripts done; code pushed to GitHub (`iodex99/offmanualdesk`), first CI run pending review. Waiting on Dwahnil for the lab VM run and decisions on Proposed ADRs.

## Next step

1. Check the first CI run of `ci.yml` on `m0-scaffold` (https://github.com/iodex99/offmanualdesk/actions); fix anything red (Rust/Tauri and PSScriptAnalyzer have only ever run in CI), then merge to `main`. This session can't read Actions for a private repo without `gh`: ask Dwahnil to paste failures or allow `gh`.
2. When lab output arrives: `/lab-result L<n>` for each; promote/supersede ADR-019…029 accordingly; flip [A] markers in ARCHITECTURE.md.
3. Unblocked meanwhile (M2, recorded exception below): Server Agent SQLite store + migrations, JSON-RPC framing over a fake pipe, TOTP/PIN verification, port-lease allocator, all with fakes for Windows-only parts.

M2 may start before M1's lab boxes are ticked: lab results only affect pipe ACL details (ADR-029), port leasing (ADR-020) and logged-off gateways (ADR-026), which M2 isolates behind interfaces.

## Waiting on Dwahnil

- [x] GitHub repo: `https://github.com/iodex99/offmanualdesk` (created 2026-11-22; `main` + `m0-scaffold` pushed). Note the name has no hyphen; docs that say `offmanual-desk` mean this repo.
- [x] GitHub CLI installed (winget, 2026-11-22).
- [ ] Approve the `gh` login: open https://github.com/login/device and enter the code Claude gave you (new code needed if it expired: ask Claude to restart `gh auth login --web`).
- [ ] **Decide Proposed ADRs** (one line each is enough), DECISIONS.md: ADR-023 (Telegram via Server Agent, no channel plugin in v1), ADR-026 (no logged-off gateways in v1), ADR-027 (guard protects against the agent, not the employee), ADR-016 (release store: Cloudflare R2 recommended), ADR-019 (production on OpenClaw `extended-stable`). The others wait for lab results.
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
- [ ] First CI run green on GitHub (needs the repo) → merge `m0-scaffold` to `main`

### M1 Research + lab spikes
- [x] OpenClaw version pinned (ADR-019: 2026.11.6, commit 06afb10d; Node 24.22.3)
- [x] OPENCLAW_NOTES.md §1–10 verified with links/paths
- [x] Assumptions that broke → Proposed ADRs (ADR-020…028; ADR-029 accepted)
- [x] `lab/` scripts for L1–L10 + `lab/README.md` runbook (parse clean on PS 5.1; L3/L7/L8/L9/L10 smoke-tested on Windows 11)
- [ ] Lab results recorded (needs Dwahnil) and ADRs updated
- [ ] Proposed ADRs decided (needs Dwahnil for 016, 019-production, 023, 026, 027)

### M2 Server Agent core
- [ ] Windows service install/uninstall/start/stop, structured logs
- [ ] SQLite local store + migrations (DATA_MODEL.md §2)
- [ ] Named pipe JSON-RPC server with OS-derived caller SID (ADR-029 DACL)
- [ ] Enrollment with console (keypair, signed requests), heartbeat
- [ ] Policy fetch → `policy.json` (read-only to users)
- [x] TOTP verification (RFC 6238, ±1 step, replay protection) in `internal/auth` (ADR-030)
- [ ] PIN hashing (argon2id) + verification, lock state, lockout
- [ ] Port + token leases for gateways (ADR-020)
- [ ] Audit log append + summary upload
- [ ] Pre-flight check command

### M3 Console core
- [ ] Auth for superadmin / staff / firm admin with mandatory TOTP
- [ ] Firms, servers, employees, invites, skill packs, AD group mappings, policies
- [ ] Agent API (enroll, heartbeat, policy, usage, audit summary, releases, support bundle)
- [ ] Employee OAuth sign-in (Google, Microsoft) + SID binding endpoint
- [ ] Fleet board v0

### M4 Desk core
- [ ] Tauri shell, autostart at logon, single instance per session
- [ ] Sign-in + SID binding + TOTP enrolment + PIN set
- [ ] Daily unlock, idle lock, PIN unlock, step-up prompt
- [ ] Gateway lifecycle: lease, start as user in a Job Object, health, stop on idle, restart (F4)
- [ ] Gateway client in Rust: protocol v4 + device auth (ADR-021)
- [ ] Docked chat panel + global hotkey
- [ ] Explorer right-click "Ask Off Manual"
- [ ] Notifications area (updates, billing, admin)

### M5 Guard plugin
- [x] Packaging + SDK typing: `openclaw.plugin.json`, `dist/plugin.js`, `before_install` block (M1)
- [ ] Lock + licence enforcement on every inbound turn (`before_agent_run`, fail-closed)
- [ ] Skill packs from policy (AD groups + console overrides)
- [ ] Access-denied handling (ADR-022: tool-result middleware + run block + Desk abort) + Request access
- [ ] Review queue (ADR-028; approve all / edit / reject), Desk UI
- [ ] Audit events to Server Agent
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
