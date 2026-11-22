# Progress

<!-- Claude Code: keep this file short enough to scan in 30 seconds. Newest session log entry first. Move finished milestones' detail into the Done summary when they are complete. -->

## Current focus

Branch `m4-desk` (CI green on every push): M2 done; M3 console core + employee binding; M4 Desk (pipe client, unlock, binding, gateway lifecycle, Rust gateway client, chat, Review tab, Telegram link, idle lock, licence banner); M5 guard (lock, licence, packs, review queue, access denied); M6 Telegram relay; M8 staging; M9 billing engine + run + ladder. Lab-dependent items wait for M1.

## Next step

1. `main` = `m4-desk` at 9501d19 (fast-forwarded 2026-11-23 after CI green); keep working on `m4-desk` and fast-forward after each green run.
2. Unblocked next: `update.status/switch` + restart-to-update (ADR-025; Doctor + backup pieces exist in Desk); gateway idle stop + crash restart; admin UI pages (employees, invites, billing, policy incl. `stepUpActions`, authenticator reset); invoice PDF; invite email behind an injectable sender (Resend key later); remaining India-pack skills (pending CA review).
3. When lab output arrives: `/lab-result L<n>` for each; promote/supersede the lab-dependent ADRs (020, 021, 022, 024, 040 session key, 041 tool registration, 043 tool list); flip [A] markers in ARCHITECTURE.md.

## Waiting on Dwahnil

- [x] GitHub repo: `https://github.com/iodex99/offmanualdesk` (created 2026-11-22; `main` + `m0-scaffold` pushed). Note the name has no hyphen; docs that say `offmanual-desk` mean this repo.
- [x] GitHub CLI installed (winget, 2026-11-22).
- [x] `gh` login approved (2026-11-22).
- [x] Proposed product ADRs accepted on Dwahnil's "do everything" instruction (016, 019, 023, 025, 026, 027, 028); overturn any by saying so. Lab-dependent ADRs (020, 021, 022, 024) stay Proposed until L1–L3.
- [ ] **Lab VM** (M1): Windows Server 2022 VM with RDS Session Host, users labA/labB/labAdmin, `Clients` share, TallyPrime educational. Exact steps: `lab/README.md` §1. Then run the scripts in the order in `lab/README.md` and paste each output with `/lab-result L<n>`.
- [ ] **Release signing key** (needed for the first real release; a dry run works without it): on your machine run `go run ./tools/sign-manifest keygen -key-id om-rel-2026a -out-public apps/server-agent/pkg/manifest/keys/om-rel-2026a.pub -out-private %USERPROFILE%\om-rel-2026a.seed`; add the seed file's content as GitHub secret `RELEASE_SIGNING_KEY` and variable `RELEASE_KEY_ID=om-rel-2026a`; commit the `.pub`; delete the seed file (keep an offline backup).
- [ ] **Review and approve skills** (`skills/offmanual/*`, status `pending` in `skills/registry.lock.json`): read each SKILL.md (ideally with your CA for the tax dates/limits), then set `review` to `{ "status": "approved", "reviewer": "Dwahnil", "date": "YYYY-MM-DD" }`. Only approved skills ship.
- [ ] Optional for development: install Visual Studio 2022 Build Tools ("Desktop development with C++") so Desk's Rust code can compile locally; today only CI can.
- [ ] Later (M3+): Postgres database URL, Vercel project (root `apps/console`), Google OAuth client and Microsoft Entra app registration (redirect URIs `<console>/auth/callback/<provider>` and `<console>/bind/callback/<provider>`), Resend API key, `CRON_SECRET` (16+ random characters) in Vercel
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
- [x] Admin UI pages: `/` sends staff to `/fleet` and firm admins to their firm; `/firms` (list; staff add firms), `/firms/[firmId]` (employees + add + switch off/on, skill packs to an employee or `OM-*` AD group, firm settings incl. step-up for approvals, enrolment codes for staff, invoices with ₹ and DD-MM-YYYY); every loader is firm-scoped on the server; [ ] invite delivery (Resend email; WhatsApp v2), billing actions UI for superadmin
- [x] Agent API v1: enroll, heartbeat, policy (ETag), audit-summary (`lib/agent-api.ts`, signed, strict bodies, PGlite-tested)
- [x] Agent API: bind (`POST /api/agent/bind`, ADR-044); [ ] usage, support bundle, notices
- [x] Employee OAuth sign-in (`/bind`, `/bind/login|callback/[provider]`, same OIDC client, no console session) → one-time code page → SID binding endpoint (ADR-044)
- [x] Fleet board v0 (`/fleet`: firm, server, health with 1 h staleness → red, last seen, version, seats)

### M4 Desk core
- [ ] Tauri shell, autostart at logon, single instance per session
- [x] Pipe client in Rust (`src-tauri/src/agent_client.rs`: CreateFileW with 0x12008B, SQOS anonymous, server must be LocalSystem, NDJSON, Desk method allowlist) + `agent_call` command
- [x] TOTP enrolment (QR) + PIN set screens (`ui/src/Unlock.tsx`); recovery codes shown once after enrolment and "Lost your phone?" → `auth.recover` → re-enrol (ADR-046)
- [x] Sign-in + SID binding: Desk signup screen (console URL + QR from `auth.bindStart`, code → `auth.bindComplete` with the OS-derived SID; 10 tries/hour)
- [x] Daily unlock, PIN unlock, switch to daily code after 3 wrong PINs, manual lock
- [x] Idle lock: session idle from `GetLastInputInfo` (Rust `idle.rs`, per RDS session) polled every 30 s, firm `lockTimeoutMax` from policy.get (default 15), fallback to in-window activity, `lock.set` then back to the unlock screen; step-up prompt on Review approvals when the firm lists `review.approve` (ADR-047)
- [x] Gateway lifecycle v1: lease → verified-keys config → `node openclaw.mjs gateway run` with env-only token → `/readyz`; Desk contains itself in a kill-on-close Job Object; stop releases the lease (`gateway.rs`, `gateway_manager.rs`, commands `gateway_start/stop/status`, UI `Assistant.tsx`)
- [x] Gateway: early exit detected during startup; exit code 78 → state snapshot (ADR-025, newest 3 kept) → `doctor --fix --yes --non-interactive` without the token (≤ 5 min) → retry once; lease released on failure; start holds the lock (no double start), status non-blocking; [ ] listener check (ADR-020, lab), idle stop, restart after a crash
- [x] Gateway client protocol v4 + device auth in Go (`server-agent/internal/gateway`, verified against OpenClaw source; used by the Telegram relay)
- [x] Gateway client in Rust (`gateway_client.rs`, ADR-021 option A): protocol v4 + device auth (port of the Go client), one background thread per Desk, device key DPAPI CurrentUser (`dpapi.rs`), scopes read/write/approvals
- [x] Chat panel (`Chat.tsx`: streaming `om-chat` events, Stop → `chat.abort`, plain errors) and Review tab (`Review.tsx`: approve / approve all / edit ticked files / reject, recent decisions); [ ] docked window + global hotkey
- [ ] Explorer right-click "Ask Off Manual"
- [~] Notifications area: licence notice banner and paused screen from `session.hello` (ADR-042); [ ] updates, admin notices

### M5 Guard plugin
- [x] Packaging + SDK typing: `openclaw.plugin.json`, `dist/plugin.js`, `before_install` block (M1)
- [x] Lock enforcement on every inbound turn (`before_agent_run` via `server-agent bridge`, 5 s cache, fail closed, Telegram window) 
- [x] Licence (firm status) enforcement (ADR-042): Server Agent `Licence` from synced `firm_status` + last console contact (7-day offline grace), carried in `lock.get` (`servicePaused`, `pausedMessage`, `notice`); guard blocks every turn while paused; Telegram router replies with the plain message
- [x] Skill packs → tool allowlist (ADR-043): `skills/packs.json` ships in the signed release; guard `before_tool_call` allows only tools of the employee's granted packs (policy.get, cached 30 s, fail closed), Telegram = core + firm-allowed packs; release tooling validates packs.json and skills' pack names; Desk passes `packsPath`. [ ] AD-group grants resolved on the server (needs lab: group names from the caller token), [ ] per-pack skill visibility in the gateway config
- [x] Access-denied handling in the guard (ADR-022: tool-result middleware rewrite + `before_tool_call` block for the rest of the run + audit event)
- [ ] Desk side: `chat.abort` + Request access button
- [x] Review queue core in the guard (ADR-028/041): `offmanual_delete_files` proposal tool, `review.json` store, approve once / reject / edit / approve all, interrupted approvals never re-run, gateway methods `offmanual.review.list|decide` (scope operator.approvals), built-in deletes blocked; [ ] Desk Review tab (needs the Rust gateway client), step-up on approve, Tally/email actions
- [x] Audit events to Server Agent (access denials)
- [ ] Telegram policy enforcement (off / text / files)

### M6 Telegram
- [x] Server Agent long-polls the firm bot (Bot API getUpdates/sendMessage), routes by linked Telegram user ID, persists the offset, ignores groups/bots, text-only by default, 4096-char chunking (`internal/telegram`)
- [x] Relay: Server Agent as gateway client (ADR-023/040) through `internal/gateway`; only to a gateway Desk started (fresh lease), else "Open Desk" (ADR-026)
- [x] Link via deep link one-time code (`telegram.linkStart`, hashed, 10 min, single use; offboarding unlinks); Desk Telegram tab shows the link as a QR code for the phone (`TelegramLink.tsx`)
- [x] `/unlock <code>` opens a Telegram-only window (firm `telegram_unlock_max_min`, default 60); [ ] inline Approve button for Desk unlock
- [ ] ~~Wake stopped gateway on message~~ out of v1 if ADR-026 is accepted

### M7 Skills
- [x] Registry tooling: `tools/skill-vet` (static checks: binaries, install scripts, git deps block; network/shell/eval/blobs/absolute paths/credentials warn; review checklist; `lock` emits pending entries) + `verify-skills` with `pending` status; release ships approved only (ADR-039)
- [ ] Starter pack imported and reviewed (SKILLS.md §3)
- [x] Client directory skill (pending review); [ ] admin scan task button
- [ ] Task buttons v1 (SKILLS.md §5)
- [~] India pack v0: `compliance-calendar`, `ledger-scrutiny` written (pending CA review); remaining: gstr2b-vs-books, ais-26as-vs-books, tds-checks, notice-reply-draft, doc-chaser, tally-mis

### M8 Updates
- [x] GitHub Actions release workflow (build, test, scan, sign, manifest, upload, register) — written and actionlint-clean; first run needs repo + signing key (done early at Dwahnil's request)
- [x] Manifest sign/verify/safe-extract library (`apps/server-agent/pkg/manifest`) + `tools/sign-manifest`
- [x] Console `POST /api/releases` (bearer `OM_RELEASE_REGISTER_TOKEN`, ring 0) and `GET /api/agent/releases` (firm pin, else newest release promoted to a ring ≥ the firm's ring)
- [ ] Release store (R2, ADR-016) + presigned URLs; workflow passes `manifestUrl`
- [x] Rings + firm pins (logic + superadmin `promote`); [ ] UI
- [x] Server Agent stage + verify + report (`internal/update`: embedded keyring, HTTPS-only, size-limited, signature → console match → min agent version → payload hash → safe extract to `.staging` → verify → rename; tampered staged copies quarantined; state in `updates`; staged version in heartbeat) [ ] Authenticode check (WinVerifyTrust)
- [x] Desk notice + restart-to-update + security deadline (ADR-048): `update.status` (staged version, severity, deadline; migration 0004), per-employee `desk\version.json`, gateway starts from `versions\<v>`, exit 78 → backup → Doctor → retry; failure restores the snapshot and the previous version; security releases install themselves after the deadline
- [x] Rollback of a failed switch (restore snapshot, previous version, ADR-025/048); [ ] console-driven rollback = firm pin to the previous version (logic exists), [ ] `current` junction move + Desk/Server Agent binary self-update
- [ ] MSI (WiX v4) for first installs

### M9 Billing
- [x] Billing engine (pure, `apps/console/lib/billing/`): all 5 line types, both seat modes, tiered/volume bands with fractional seats, mid-month proration, versioned per-seat lines, adjustments, usage with quota + markup (ADR-038)
- [x] Contracts/invoices tables (migration 0003: contracts, contract_lines (engine spec jsonb), invoices, invoice_lines, payments, invoice_counters, ladder_overrides); superadmin API `POST /api/admin/billing` (run/issue/payment/refresh/override) and firm-scoped `GET /api/admin/firms/[firmId]/invoices`; invoice list on the firm page; [ ] superadmin billing actions UI
- [x] GST split (same state CGST+SGST, else IGST; per-tax paisa rounding) and amount in words (Indian numbering)
- [x] Invoice run (`lib/billing/run.ts`: drafts per firm/month, refreshed in place until issued; seat days from binding/disable dates + usage_daily activity; mid-month versions) + FY numbering on issue (`OM/FY2026-27/0001`, counter in a transaction; drafts only until `OFFMANUAL_GSTIN` is set); daily scheduler `/api/cron/billing` (Vercel Cron 01:00 IST, `CRON_SECRET` bearer, constant-time; drafts on the 1st, statuses daily); [ ] PDF
- [ ] Razorpay (payment links, UPI AutoPay / e-mandate), webhooks
- [ ] Notification engine + Desk banners
- [x] Enforcement ladder logic + override with reason + offline grace (`ladder.ts`)
- [x] Ladder wired end to end: `refreshFirmStatus` sets `firms.status` from issued invoices + contract grace/suspend days + override with reason (ADR-045); heartbeat carries it; agent, guard, Telegram and Desk enforce/show it (ADR-042); daily via the cron route; [ ] override UI

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

### 2026-11-23 12:40: Console admin pages (M3)
- Changed: `lib/admin.ts` `firmOverview` (firm, policy, grants, pack catalogue; firm-scoped), pages `app/firms/page.tsx`, `app/firms/[firmId]/page.tsx`, client forms `app/firms/forms.tsx` (JSON to the existing admin APIs, plain messages, confirm before switching someone off), `app/firms/session.ts` (sign-in redirect, 403 page), home page redirect by role. Also fixed CI E0308 in the restart-to-update slice (`.into()` for StartFailure); CI run 45031941156 green.
- Tests: console 99/99 (firmOverview: own admin and staff see it, other firm's admin refused, pre-MFA 401, unknown firm); `next build` lists `/firms` and `/firms/[firmId]`. Not exercised in a browser (no database here).
- Half-done / next: superadmin billing UI (run/issue/payment/override), invite email.

### 2026-11-23 12:00: Restart to update (M8)
- Changed: agent migration 0004 (`updates.severity`, `deadline_at`), store `SetUpdateMeta`/`StagedRelease`, Syncer records severity + deadline (console already sends `deadlineAt`), pipe `update.status`; Desk Rust `versions.rs` (strict version strings, install base, installed check, root_for, version_of via the `current` junction, choice load/save atomically), `gateway_manager` (start from the chosen version; StartFailure carries the Doctor snapshot; `apply_update` with rollback; `update_status`), `gateway::restore_backup` (failed state kept once), commands `update_status`/`update_apply`; UI `UpdateNotice.tsx` in the Assistant. Fixed a stray control character in ARCHITECTURE F4. ADR-048.
- Tests: Go store meta + update.status (normal/security/unknown severity, unknown caller), schema version 4; desk 37/37 (notice, restart, security date, auto-install after deadline, rollback message, quiet on errors, single check with the default clock — caught a re-render loop before shipping); Rust versions (strict versions, root choice, bad files) and restore (CI); golangci-lint both OSes 0.
- Half-done / next: `current` junction move when every employee has switched; Desk and Server Agent self-update; admin view of who is on which version.

### 2026-11-23 11:20: Step-up for review approvals (F3/F6)
- Changed: agent `auth.stepUpCheck` (grant checked for the OS caller; shared IPC schema), guard bridge allows it, guard `review-api.ts` (decide validation + firm `stepUpActions` contains `review.approve` → `{stepUpRequired}` until a live grant is sent; unreadable policy blocks approval, reject never needs step-up), Rust `decide_params` carries a 32-hex `stepUpGrant`, Desk Review tab asks for today's code (`auth.stepUp`) and retries. ADR-047.
- Tests: Go stepUpCheck (own grant valid, other employee's not, bad action, expiry); guard 71/71; desk 31/31; Rust decide_params grant test (CI); golangci-lint both OSes 0; CI for recovery codes green.
- Half-done / next: merge `m4-desk` → `main`.

### 2026-11-23 10:50: Recovery codes (F2 step 4)
- Changed: store `recovery.go` (SetRecoveryCodes, RecoveryCodesLeft, UseRecoveryCode: atomic, resets TOTP secret/enrolment/counter), agent `recovery.go` (8 codes XXXXX-XXXXX from the no-look-alike alphabet, salted sha256 hashes only, `auth.recover` with 5 tries/hour per SID, day grant revoked, audit), totpEnrolConfirm returns the codes once, shared `limited()` helper (bind uses it too); shared IPC schema + Desk Rust allowlist add `auth.recover`; Desk codes screen and recovery screen. ADR-046.
- Tests: Go recovery (format, uniqueness, hashes only, wrong code, case/dash-insensitive, reset → re-enrol with fresh codes, single use, rate limit + window, unknown caller); the schema test caught the missing IPC entry; desk 30/30; golangci-lint both OSes 0; CI run for the Doctor retry green (real `cmd /C exit 78`).
- Half-done / next: admin reset of an employee's authenticator (console → policy flag); step-up prompt.

### 2026-11-23 10:20: Gateway Doctor retry (M4, F4)
- Changed: `gateway.rs` (EXIT_NEEDS_DOCTOR, doctor_arguments/environment, Startup + wait_ready_or_exit, backup_state with recursive copy and pruning, `backups_dir` in Layout; probe-only `wait_ready` now test-only), `gateway_manager.rs` (start loop with one Doctor retry, spawn/run_doctor/release helpers, try_lock in status).
- Tests (CI only): early exit 78 seen via a real `cmd /C exit 78`, ready while a process runs, doctor args/env without token, backup copy + keep newest 3, needs_doctor rules.
- Half-done / next: idle stop + crash restart; listener check after lab L1/L2.

### 2026-11-23 09:50: Billing tables, invoice run, issue, payments, ladder → firm status (M9)
- Changed: console schema + migration 0003, `lib/billing/run.ts` (parseLineSpec with strict zod, seatDaysFor, generateDraft, runMonth, issueInvoice, recordPayment, refreshFirmStatus, billingConfigFromEnv), `lib/billing/admin.ts` (superadmin actions, firm-scoped invoice list with money as strings), routes `/api/admin/billing`, `/api/admin/firms/[firmId]/invoices`. ADR-045.
- Tests: console 96/96 (11 new, figures by hand: setup + AMC + 1.5 prorated seats with CGST/SGST; IGST; draft refreshed in place; mid-month version proration; usage only on Off Manual's key; FY numbering 0001/0002; one-time billed once; partial then full payment; ladder active → overdue → restricted → suspended, override with reason and expiry, payment restores, closed untouched; roles: staff/firm admin/anonymous refused, drafts hidden from firm admins, cross-firm refused); `next build` lists both routes. CI run for idle lock + binding all green.
- Then: `/api/cron/billing` + `apps/console/vercel.json` cron (19:30 UTC = 01:00 IST); tests 13/13 in billing-run (secret required, 1st-of-month drafts, year wrap).
- Half-done / next: invoice PDF, Razorpay (needs keys), billing UI.

### 2026-11-23 09:10: Desk idle lock (M4, F3)
- Changed: Rust `idle.rs` (GetLastInputInfo + GetTickCount with wrap-safe elapsed; third audited unsafe module) and command `idle_seconds`; windows-sys features SystemInformation + KeyboardAndMouse (verified in 0.61.2 source); UI `idleLock.ts` hook wired into Unlock's ready state.
- Tests: desk 29/29 (timeout bounds, locks at the timeout only, window-activity fallback, inactive does nothing); Rust wrap test + real read on the CI runner.
- Half-done / next: step-up prompt; per-employee shorter timeout setting.

### 2026-11-23 08:45: Employee sign-in and SID binding (M3/M4, F2)
- Changed: console `bind_codes` table (migration 0002), `lib/bind.ts` (createBindCode by verified email, one live code per employee, same OIDC subject once bound; redeemBindCode in a transaction: same answer for unknown/used/expired/other-firm, refuses a different SID or a SID bound to someone else, activates, accepts invite, returns packs), `lib/bind-routes.ts` + `/bind` page and routes (code page escaped, no-store, CSP), `agentBind` handler; `auth-routes.ts` refactored (`verifyCallback`, configurable callback). Agent: `console.Client.Bind`, `auth.bindStart`/`auth.bindComplete` (caller SID only, strict params, 10 attempts/hour, disabled refused, local upsert), app `binderFor` (4xx console messages shown, 401 never). Desk signup screen. ADR-044.
- Tests: console 85/85 (9 new: codes, refusals, single use, no oracle, SID conflicts, signed endpoint incl. other firm + unknown field, sign-in pages); Go agent/console/app bind tests; desk 25/25; `next build` lists the 4 new routes; golangci-lint both OSes 0.
- Half-done / next: invite email (Resend, needs key); admin UI for employees; recovery codes (F2 step 4).

### 2026-11-23 08:00: Desk licence banner
- Changed: `session.hello` returns servicePaused/pausedMessage/notice; Desk shows the paused message (with Check again) instead of starting the assistant, and the overdue notice above it.
- Tests: agent hello carries licence; desk vitest 24/24 (paused screen doesn't start the gateway, notice banner); golangci-lint 0.
- Half-done / next: console firm status from the ladder.

### 2026-11-23 07:45: Skill packs gate tools (M5)
- Changed: `skills/packs.json` (core tools; other packs empty until their tools exist), guard `src/packs.ts` (parse/validate, allowedTools per channel, packBlockReason with `bash`→`exec` alias, PolicyCache), `plugin.ts` before_tool_call pack check before the delete check + `tool_blocked/not_in_pack` audit, manifest `packsPath`; `tools/release/lib.mjs` checks packs.json and unknown pack names; release workflow ships packs.json; Desk config passes `packsPath`. ADR-043.
- Tests: guard 66/66 (bad files, shipped packs.json valid and never grants denied tools, union, Telegram intersection, fail closed, cache); release tools 18/18 (missing core, unknown pack, bad tool name, bad JSON); Rust config assertion (CI); actionlint clean; CI run 45025138445 green for the licence slice.
- Half-done / next: AD-group pack grants on the server; skill visibility per pack; Desk banner for licence notice.

### 2026-11-23 07:15: Licence enforcement (M5/M9)
- Changed: agent `licence.go` (Licence / PausedMessage: not activated, suspended/closed → paused, unknown status or bad timestamp → paused, offline > 7 days → paused, overdue/restricted → usable with notice), `lockStatus` gains servicePaused/pausedMessage/notice; Telegram `Hooks.Paused` checked before mode and relay; guard `lockGate` blocks with reason `licence` on both channels before any lock rule. ADR-042.
- Tests: agent licence table (9 cases + never synced + bad timestamp) and lock.get fields; telegram paused reply without relaying; guard 60/60; Go vet both OSes, golangci-lint both OSes 0; CI run 45024580640 green incl. Desk Rust (first compile of the gateway client).
- Half-done / next: console computes firm status from the ladder (needs billing tables); Desk banner for `notice`.

### 2026-11-23 06:45: Desk gateway client, chat panel, Review tab (M4)
- Changed: Rust `gateway_client.rs` (tungstenite 0.30 sync client on a dedicated thread, ed25519-dalek 3, sha2 0.11, base64 0.23, getrandom 0.4; APIs checked in the fetched crate sources), `dpapi.rs` (CryptProtectData/CryptUnprotectData CurrentUser + entropy; second audited unsafe module), `chat.rs` (connect on first use, plain errors, message limit 20 000 chars, review param checks), Tauri commands `chat_send`, `chat_abort`, `review_list`, `review_decide`; `GatewayState::endpoint`; UI `gatewayApi.ts`, `Chat.tsx`, `Review.tsx`, tabs in `Assistant.tsx` (Chat, Review, Telegram: `TelegramLink.tsx` shows the one-time link as a QR code, only `https://t.me/` links accepted).
- Tests: desk vitest 22/22 (streaming, events before the run id, replace, stop, plain errors, approve / approve all / reject / edit / retry, Telegram link QR + plain errors + non-Telegram URL refused); Rust tests (payload string identical to the Go test, signature verifies, chat-event trimming, fake gateway re-implementing the v3 signature + device-id check: handshake, request, events, error, hang-up, wrong token → Auth, nothing listening, DPAPI round trip + tamper, review param shapes) run in CI only.
- Half-done / next: lab L2 confirms client.id/mode and session keys; docked window + hotkey; Telegram approve-unlock button.

### 2026-11-23 06:00: Review queue core (M5)
- Changed: guard `src/review.ts` (ReviewStore: JSON file, serialised writes, atomic rename, finished-item cap, corrupt file refuses to load, interrupted approvals → failed; ReviewQueue: propose/decide; `bypassBlockReason` for exec/apply_patch/fs_delete deletes), `src/delete-files.ts` (first action: absolute/UNC paths only, files only, Windows rights decide), `plugin.ts` registers the tool, the two gateway methods and the before_tool_call check; manifest `contracts.tools`. ADR-041. OPENCLAW_NOTES §4: registerTool / registerGatewayMethod / contracts.tools / resolveStateDir / tools-invoke facts.
- Tests: guard 58/58 (persistence, concurrent adds, exactly-once approval under a race, reject, validated edit, approve all with failures and thrown errors, path rules, real delete in a temp dir, 13 delete-command patterns blocked and 6 ordinary commands allowed); `pnpm run check` green.
- Half-done / next: Rust gateway client + Desk Review tab; lab L-guard confirms a plain JSON Schema tool registers and the plugin's gateway methods are reachable.

### 2026-11-23 05:00: Telegram router + relay (M6)
- Changed: migration 0003 (`leases.token_dpapi`), store Telegram methods (link codes, links, protected lease token; DisableEmployee also unlinks), `internal/telegram` (Bot client, Router with plain replies, Run with backoff), agent `telegram.linkStart`, `TelegramUnlock`, mode/active hooks, `UserMessage` error type, lease stores the protected token; app relay (`gateway.Dial` + `Chat` on session `agent:main:telegram`, persistent relay device key), router start when configured, `server-agent telegram-setup` (token from stdin). ADR-040.
- Tests: telegram 88.3% (linking, expiry, reuse, unlinked/offboarded, off mode, files refused, relay + chunking + not running + error, /unlock, groups/bots ignored, offset persistence, Bot client errors never contain the token); agent 76.7% (link start, unlock window, protected token); golangci-lint both OSes 0.
- Half-done / next: Desk "Link Telegram" button + Telegram approve-unlock button; lab L2 confirms the session key format.

### 2026-11-23 04:15: Gateway client protocol (Go)
- Changed: `internal/gateway/client.go` (Device with sha256 id + base64url key/signature, PayloadV3, Dial with connect.challenge → connect → hello-ok, Chat accumulating deltas with replace, Abort), dependency github.com/coder/websocket v1.8.15. OPENCLAW_NOTES: device-auth and chat-event facts verified in source.
- Tests: gateway 82.9% against a fake gateway that re-implements the server's v3 signature + device id checks (handshake, wrong token refused, streamed reply, error/aborted, other runs' events ignored).
- Half-done / next: Telegram router (Bot API long poll, linking, relay through this client).

### 2026-11-23 03:45: Skill vetting + first India-pack skills (M7)
- Changed: `tools/skill-vet/vet.mjs` (check/lock CLI, rules, checklist); `verifySkillsLock` accepts `pending` (hash-checked, never shipped) and reports approved count; release workflow copies and locks only approved skills; skills `offmanual/client-directory`, `compliance-calendar`, `ledger-scrutiny` (instruction-only, no scripts; pending review); `test:tools` runs every tool's tests. ADR-039.
- Tests: tools 17/17 (vet rules incl. a fixed gap: `C:\\` double-backslash paths); verify-skills OK (3 pending); actionlint clean.
- Half-done / next: remaining India-pack skills, task buttons, starter-pack vendoring (needs ClawHub downloads + human review).

### 2026-11-23 03:00: Update pipeline: console releases + agent staging (M8)
- Changed: console `lib/releases.ts` (register with constant-time bearer check, promote, assignedRelease), routes `/api/releases`, `/api/agent/releases`; agent `pkg/manifest/trusted.go` (go:embed keys, CompareVersions), `internal/update/stager.go`, store update-state methods, Syncer stages in the background (single flight) and reports `stagedVersion`; `installRoot()` (`OFFMANUAL_INSTALL_ROOT` override).
- Tests: console 76/76 (registration auth, ring eligibility, pins, promote roles); Go all pass (update 77%: success + idempotent + tampered payload + foreign key + empty keyring + console mismatch + needs newer agent + non-HTTPS + tampered staged copy); golangci-lint both OSes 0.
- Half-done / next: release store (needs Cloudflare account), `update.status/switch` pipe methods + Desk restart-to-update with state backup + doctor (ADR-025).

### 2026-11-23 02:15: Billing engine (M9 core)
- Changed: `apps/console/lib/billing/money.ts` (bigint paise, half-away-from-zero rounding, basis points, Indian amount in words), `engine.ts` (computeInvoice for one month, seatQuantity as exact fractions, seatAmount tiered/volume, recurring schedule, GST split), `ladder.ts` (state by oldest unpaid invoice, override, capabilities, offline grace). ADR-038.
- Tests: billing 21/21 (all figures worked by hand from BILLING.md); console total 71/71; typecheck/lint/format clean.
- Half-done / next: billing tables + invoice run + PDF + Razorpay (needs keys) + notifications.

### 2026-11-23 01:45: Desk gateway: CI fixes
- Changed: CI (only place Rust compiles) found E0596 (mutable borrow in a match guard in `status`), an unread `Job` field (dead_code under -D warnings), and a real bug: the readiness probe assumed the HTTP status line arrives in one TCP read; it now reads to CRLF.
- Tests: CI run 45019566627 all green (Rust clippy + 16 tests on windows-latest).

### 2026-11-23 01:15: Desk gateway lifecycle (M4)
- Changed: branch `m4-desk` (main now includes M0–M2 and the M3/M5 starts). Rust `gateway.rs` (layout per ARCHITECTURE §5, config from verified keys only: loopback, token auth, exemptLoopback false, Control UI + terminal off, updates/telemetry off, telegram/browser/device-pair denied, guard via load.paths with bridgeCommand, skills lockdown, tool denies; env preset incl. OPENCLAW_CONFIG_READONLY; args; `/readyz` poll over raw HTTP; Job Object via windows-sys JobObjects, API verified in crate source), `gateway_manager.rs` (token kept in Rust), Tauri commands; UI `Assistant.tsx` shown after unlock.
- Tests: desk vitest 10/10; Rust unit tests (config lockdown, token only in env, readiness against a local TCP server) run in CI; fmt clean.
- Half-done / next: chat client (gateway WS protocol v4 + device auth, ADR-021), listener check, idle lock.

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
