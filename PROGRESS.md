# Progress

<!-- Claude Code: keep this file short enough to scan in 30 seconds. Newest session log entry first. Move finished milestones' detail into the Done summary when they are complete. -->

## Current focus

Branch `m4-desk` (CI green on every push; `main` fast-forwarded after each green run). Built and unit/CI-tested: Server Agent (M2), console core, admin pages, billing (M3/M9), Desk core incl. chat, review, tasks, Request access, single instance, hotkey (M4), guard (M5), Telegram (M6), skills tooling + India pack pending review (M7), release staging, `current` switch, releases page (M8), setup, digest, support, fleet (M10), security review, backups, offboarding archive (M11). Lab-dependent items wait for M1. Razorpay payment links + webhook built (M9); live check needs keys.

## Next step

1. `main` = `m4-desk` at 2d97076; watch CI by commit (`gh run list --commit <sha>`) and fast-forward after each green run.
2. Next: UPI AutoPay / e-mandate; the remaining starter-pack skills; live Razorpay check once test keys exist.
3. When lab output arrives: `/lab-result L<n>` for each; promote/supersede the lab-dependent ADRs (020, 021, 022, 024, 040 session key, 041 tool registration, 043 tool list); flip [A] markers in ARCHITECTURE.md.

## Waiting on Dwahnil

- [x] GitHub repo: `https://github.com/iodex99/offmanualdesk` (created 2026-11-22; `main` + `m0-scaffold` pushed). Note the name has no hyphen; docs that say `offmanual-desk` mean this repo.
- [x] GitHub CLI installed (winget, 2026-11-22).
- [x] `gh` login approved (2026-11-22).
- [x] Proposed product ADRs accepted on Dwahnil's "do everything" instruction (016, 019, 023, 025, 026, 027, 028); overturn any by saying so. Lab-dependent ADRs (020, 021, 022, 024) stay Proposed until L1–L3.
- [ ] **Lab VM** (M1): Windows Server 2022 VM with RDS Session Host, users labA/labB/labAdmin, `Clients` share, TallyPrime educational. Exact steps: `lab/README.md` §1. Then run the scripts in the order in `lab/README.md` and paste each output with `/lab-result L<n>`.
- [ ] **Release signing key** (needed for the first real release; a dry run works without it): on your machine run `go run ./tools/sign-manifest keygen -key-id om-rel-2026a -out-public apps/server-agent/pkg/manifest/keys/om-rel-2026a.pub -out-private %USERPROFILE%\om-rel-2026a.seed`; add the seed file's content as GitHub secret `RELEASE_SIGNING_KEY` and variable `RELEASE_KEY_ID=om-rel-2026a`; commit the `.pub`; delete the seed file (keep an offline backup).
- [x] **Skills approved** (25-11-2026, Dwahnil's instruction "put the 9 skills in"): all 9 in `skills/offmanual/*` are `approved` in `skills/registry.lock.json` and ship with the next release. A CA read of the tax dates and limits in compliance-calendar, tds-checks and ais-26as-vs-books is still worth doing before a pilot firm relies on them.
- [ ] Optional for development: install Visual Studio 2022 Build Tools ("Desktop development with C++") so Desk's Rust code can compile locally; today only CI can.
- [ ] Later (M3+): Postgres database URL, Vercel project (root `apps/console`), Google OAuth client and Microsoft Entra app registration (redirect URIs `<console>/auth/callback/<provider>` and `<console>/bind/callback/<provider>`), Resend API key, `CRON_SECRET` (16+ random characters) in Vercel
- [ ] Later (M6): Telegram bot token for the lab firm
- [x] **MSI tool licence**: decided 25-11-2026: use WiX v7 now (EULA accepted in CI and the release workflow), pay the sponsorship when revenue reaches US$10,000 a year (ADR-071).
- [x] **Telegram Approve for Desk unlock**: decided 25-11-2026, option (b): in place of the PIN only, after the day's authenticator unlock (ADR-068, built).
- [x] **Python for the Excel skill**: decided 25-11-2026: ship everything, the firm installs nothing (ADR-072).
- [x] **Imported skills approved** (Excel, Word) on Dwahnil's instruction, 25-11-2026.
- [ ] Later (M8): Azure Trusted Signing account (or code-signing certificate) as GitHub secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` + variables `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_CERT_PROFILE`; release store (ADR-016) secrets `RELEASE_STORE_*`
- [ ] Later (M9): Razorpay test keys (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` in Vercel), a webhook in the Razorpay dashboard to `<console>/api/razorpay/webhook` for `payment_link.paid` with its secret as `RAZORPAY_WEBHOOK_SECRET`; Off Manual GSTIN, state, SAC code confirmed with the CA

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
- [x] Admin UI pages: `/` sends staff to `/fleet` and firm admins to their firm; `/firms` (list; staff add firms), `/firms/[firmId]` (employees + add + switch off/on, skill packs to an employee or `OM-*` AD group, firm settings incl. step-up for approvals, enrolment codes for staff, invoices with ₹ and DD-MM-YYYY); every loader is firm-scoped on the server; invite email on add (Resend, `lib/email.ts`; invites.sent_at; failure never undoes the add) + "Send invite again"; superadmin `/billing` page (make drafts, issue with confirm, record payments in rupees, override with reason and date, refresh statuses); [ ] WhatsApp invites (v2)
- [x] Agent API v1: enroll, heartbeat, policy (ETag), audit-summary (`lib/agent-api.ts`, signed, strict bodies, PGlite-tested)
- [x] Agent API: bind (`POST /api/agent/bind`, ADR-044), support (`POST /api/agent/support`, ADR-050), usage (`POST /api/agent/usage`, ADR-051), notices (`GET /api/agent/notices`, ADR-052)
- [x] Employee OAuth sign-in (`/bind`, `/bind/login|callback/[provider]`, same OIDC client, no console session) → one-time code page → SID binding endpoint (ADR-044)
- [x] Fleet board v0 (`/fleet`: firm, server, health with 1 h staleness → red, last seen, version, seats)

### M4 Desk core
- [x] Tauri shell; single instance per session (ADR-059: `Local\OffManualDesk` mutex, second launch forwards through the per-user inbox + wake event and exits); autostart at logon (MSI HKLM Run, ADR-071), [ ] L8 on the RDS host
- [x] Pipe client in Rust (`src-tauri/src/agent_client.rs`: CreateFileW with 0x12008B, SQOS anonymous, server must be LocalSystem, NDJSON, Desk method allowlist) + `agent_call` command
- [x] TOTP enrolment (QR) + PIN set screens (`ui/src/Unlock.tsx`); recovery codes shown once after enrolment and "Lost your phone?" → `auth.recover` → re-enrol (ADR-046)
- [x] Sign-in + SID binding: Desk signup screen (console URL + QR from `auth.bindStart`, code → `auth.bindComplete` with the OS-derived SID; 10 tries/hour)
- [x] Daily unlock, PIN unlock, switch to daily code after 3 wrong PINs, manual lock
- [x] Idle lock: session idle from `GetLastInputInfo` (Rust `idle.rs`, per RDS session) polled every 30 s, firm `lockTimeoutMax` from policy.get (default 15), fallback to in-window activity, `lock.set` then back to the unlock screen; step-up prompt on Review approvals when the firm lists `review.approve` (ADR-047)
- [x] Gateway lifecycle v1: lease → verified-keys config → `node openclaw.mjs gateway run` with env-only token → `/readyz`; Desk contains itself in a kill-on-close Job Object; stop releases the lease (`gateway.rs`, `gateway_manager.rs`, commands `gateway_start/stop/status`, UI `Assistant.tsx`)
- [x] Gateway: early exit detected during startup; exit code 78 → state snapshot (ADR-025, newest 3 kept) → `doctor --fix --yes --non-interactive` without the token (≤ 5 min) → retry once; lease released on failure; start holds the lock (no double start), status non-blocking; idle stop after the firm's `gatewayIdleStopHours` + start on the next message/review action + crash restart (≤ 3/hour) in `ui/src/keeper.ts`; [ ] listener check (ADR-020, lab)
- [x] Gateway client protocol v4 + device auth in Go (`server-agent/internal/gateway`, verified against OpenClaw source; used by the Telegram relay)
- [x] Gateway client in Rust (`gateway_client.rs`, ADR-021 option A): protocol v4 + device auth (port of the Go client), one background thread per Desk, device key DPAPI CurrentUser (`dpapi.rs`), scopes read/write/approvals
- [x] Chat panel (`Chat.tsx`: streaming `om-chat` events, Stop → `chat.abort`, plain errors) and Review tab (`Review.tsx`: approve / approve all / edit ticked files / reject, recent decisions); docked panel (right edge of the work area at start) + global hotkey Ctrl+Alt+O (ADR-064); Settings tab: dock side + own shorter lock time (ADR-066); [ ] L8 on the RDS host
- [x] Explorer right-click "Ask Off Manual": `--ask <path>` handled (forwarded to the running Desk, path put in the chat box, ADR-059); verb registered by the MSI (ADR-071)
- [x] Notifications area: licence banner/paused screen (ADR-042), update notice (ADR-048), notices from Off Manual and the firm with Dismiss (ADR-052)

### M5 Guard plugin
- [x] Packaging + SDK typing: `openclaw.plugin.json`, `dist/plugin.js`, `before_install` block (M1)
- [x] Lock enforcement on every inbound turn (`before_agent_run` via `server-agent bridge`, 5 s cache, fail closed, Telegram window) 
- [x] Licence (firm status) enforcement (ADR-042): Server Agent `Licence` from synced `firm_status` + last console contact (7-day offline grace), carried in `lock.get` (`servicePaused`, `pausedMessage`, `notice`); guard blocks every turn while paused; Telegram router replies with the plain message
- [x] Skill packs → tool allowlist (ADR-043): `skills/packs.json` ships in the signed release; guard `before_tool_call` allows only tools of the employee's granted packs (policy.get, cached 30 s, fail closed), Telegram = core + firm-allowed packs; release tooling validates packs.json and skills' pack names; Desk passes `packsPath`. [ ] AD-group grants resolved on the server (needs lab: group names from the caller token), per-pack skill visibility in the gateway config (ADR-069: lease carries packs, Desk sets `agents.defaults.skills` from the shipped lock; fail closed)
- [x] Access-denied handling in the guard (ADR-022: tool-result middleware rewrite + `before_tool_call` block for the rest of the run + audit event)
- [x] Desk side: Request access (ADR-058): card after a reply for each folder refused since it was sent, note to the firm's admins (local only), Access tab (own requests; admins close them); no `chat.abort` needed (guard blocks further tools)
- [x] Review queue core in the guard (ADR-028/041): `offmanual_delete_files` proposal tool, `review.json` store, approve once / reject / edit / approve all, interrupted approvals never re-run, gateway methods `offmanual.review.list|decide` (scope operator.approvals), built-in deletes blocked; Desk Review tab (`Review.tsx`) and step-up on approve (ADR-047) done; [ ] Tally and email proposal actions (need the Tally-post / email packs)
- [x] Audit events to Server Agent (access denials)
- [x] Telegram policy enforcement (off / text / files) in the Server Agent router; replies stripped of encoded dumps and local links (security review #5)

### M6 Telegram
- [x] Server Agent long-polls the firm bot (Bot API getUpdates/sendMessage), routes by linked Telegram user ID, persists the offset, ignores groups/bots, text-only by default, 4096-char chunking (`internal/telegram`)
- [x] Relay: Server Agent as gateway client (ADR-023/040) through `internal/gateway`; only to a gateway Desk started (fresh lease), else "Open Desk" (ADR-026)
- [x] Link via deep link one-time code (`telegram.linkStart`, hashed, 10 min, single use; offboarding unlinks); Desk Telegram tab shows the link as a QR code for the phone (`TelegramLink.tsx`)
- [x] `/unlock <code>` opens a Telegram-only window (firm `telegram_unlock_max_min`, default 60); inline Approve button for Desk unlock in place of the PIN only, after the day's authenticator code (ADR-068, Dwahnil's choice (b))
- [ ] ~~Wake stopped gateway on message~~ out of v1 if ADR-026 is accepted

### M7 Skills
- [x] Registry tooling: `tools/skill-vet` (static checks: binaries, install scripts, git deps block; network/shell/eval/blobs/absolute paths/credentials warn; review checklist; `lock` emits pending entries) + `verify-skills` with `pending` status; release ships approved only (ADR-039)
- [~] Starter pack (SKILLS.md §3): Excel and Word imported 25-11-2026 (`skills/vendored/ivangdavila__*`, MIT-0, adapted, pending Dwahnil's approval); PDF skill rejected (proprietary licence; built-in `pdf` tool covers reading); Excel and Word approved 25-11-2026; Python shipped (ADR-072); [ ] remaining starter skills (Tally, accountant, bank recon, GST, ID check, income tax, Outlook/Google, memory, diagnostics, web search)
- [x] Client directory skill (pending review); scan started from the Desk task "Build client list" (ADR-054)
- [x] Task buttons v1 (SKILLS.md §5): Desk Tasks tab (`tasks.ts`, `TaskButtons.tsx`) with client/month/FY/period/file inputs; each sends one request naming the skill and the §5 output file through the chat; role defaults (ADR-061: console task role per employee → policy → `session.hello` → role's buttons first, others under More tasks); [ ] Purchase bills to vouchers (needs the Tally-post pack)
- [x] India pack v1 written and approved by Dwahnil on 25-11-2026 (ships with the next release): compliance-calendar, ledger-scrutiny, gstr2b-vs-books, ais-26as-vs-books, tds-checks (rates only from the firm's own reviewed table), notice-reply-draft (never files), doc-chaser (never contacts clients), tally-mis (tally-read pack)

### M8 Updates
- [x] GitHub Actions release workflow (build, test, scan, sign, manifest, upload, register) — written and actionlint-clean; first run needs repo + signing key (done early at Dwahnil's request)
- [x] Manifest sign/verify/safe-extract library (`apps/server-agent/pkg/manifest`) + `tools/sign-manifest`
- [x] Console `POST /api/releases` (bearer `OM_RELEASE_REGISTER_TOKEN`, ring 0) and `GET /api/agent/releases` (firm pin, else newest release promoted to a ring ≥ the firm's ring)
- [ ] Release store (R2, ADR-016) + presigned URLs; workflow passes `manifestUrl`
- [x] Rings + firm pins (logic + superadmin `promote`) and superadmin `/releases` page (promote, firm ring + pin = rollback, servers running/staged per version); only Authenticode-signed releases leave ring 0 unless `OM_ALLOW_UNSIGNED_RELEASES=true` (ADR-057)
- [x] Server Agent stage + verify + report (`internal/update`: embedded keyring, HTTPS-only, size-limited, signature → console match → min agent version → payload hash → safe extract to `.staging` → verify → rename; tampered staged copies quarantined; state in `updates`; staged version in heartbeat); Authenticode check (ADR-055: manifest `authenticode` flag set by the release workflow when it signed; then every .exe/.dll must pass WinVerifyTrust with whole-chain revocation)
- [x] Desk notice + restart-to-update + security deadline (ADR-048): `update.status` (staged version, severity, deadline; migration 0004), per-employee `desk\version.json`, gateway starts from `versions\<v>`, exit 78 → backup → Doctor → retry; failure restores the snapshot and the previous version; security releases install themselves after the deadline
- [x] Rollback of a failed switch (restore snapshot, previous version, ADR-025/048); console-driven rollback = firm pin to the previous version on `/releases`, `current` junction move + Server Agent self-update (ADR-062: quiet hours 02–05 IST with no active lease, or a security deadline; restart via SCM recovery incl. non-crash failures); Desk binary follows at the next sign-in
- [x] MSI for first installs (ADR-071): `installer/OffManual.wxs` (WiX 7.0.1): files to `versions\<v>`, `server-agent setup` custom action (current, enrolment via `CONSOLEURL`/`ENROLCODE`, service), Desk autostart + Explorer verb in HKLM, `teardown` on uninstall, rollback on failure; CI installs/uninstalls it; release attaches `OffManual-<v>.msi`. WebView2 installer inside the MSI, run by setup only when missing (ADR-072); [ ] sign the MSI, [ ] check long `node_modules` paths on a real release build

### M9 Billing
- [x] Billing engine (pure, `apps/console/lib/billing/`): all 5 line types, both seat modes, tiered/volume bands with fractional seats, mid-month proration, versioned per-seat lines, adjustments, usage with quota + markup (ADR-038)
- [x] Contracts/invoices tables (migration 0003: contracts, contract_lines (engine spec jsonb), invoices, invoice_lines, payments, invoice_counters, ladder_overrides); superadmin API `POST /api/admin/billing` (run/issue/payment/refresh/override) and firm-scoped `GET /api/admin/firms/[firmId]/invoices`; invoice list on the firm page; superadmin `/billing` page
- [x] GST split (same state CGST+SGST, else IGST; per-tax paisa rounding) and amount in words (Indian numbering)
- [x] Invoice run (`lib/billing/run.ts`: drafts per firm/month, refreshed in place until issued; seat days from binding/disable dates + usage_daily activity; mid-month versions) + FY numbering on issue (`OM/FY2026-27/0001`, counter in a transaction; drafts only until `OFFMANUAL_GSTIN` is set); daily scheduler `/api/cron/billing` (Vercel Cron 01:00 IST, `CRON_SECRET` bearer, constant-time; drafts on the 1st, statuses daily); invoice PDF (`lib/billing/pdf.ts`, pdf-lib 1.17.1: both GSTINs, place of supply, SAC, CGST/SGST or IGST, total in words; drafts marked; route `GET .../invoices/[invoiceId]/pdf`, drafts staff-only)
- [x] Razorpay payment links + webhook (ADR-065): link on issue (and daily retry), *Pay online* for firm admins, `payment_link.paid` recorded once per payment, notices end, firm status refreshed; receipts emailed to the firm's admins for every payment (ADR-067); [ ] UPI AutoPay / e-mandate (BILLING §4), [ ] live check with test keys
- [x] Notification engine + Desk banners (ADR-052): billing notices for firm admins (issued, due in 7 days, due today, overdue; once each; end when paid), staff/firm-admin notices from the console; email copies of billing notices to the firm's active admins (ADR-053)
- [x] Enforcement ladder logic + override with reason + offline grace (`ladder.ts`)
- [x] Ladder wired end to end: `refreshFirmStatus` sets `firms.status` from issued invoices + contract grace/suspend days + override with reason (ADR-045); heartbeat carries it; agent, guard, Telegram and Desk enforce/show it (ADR-042); daily via the cron route; override UI on the superadmin `/billing` page (state, reason, until)

### M10 Admin and ease
- [ ] Admin agent tools
- [x] Setup (ADR-054): firm page shows each server's pre-flight problems (must fix / check, with the fix), bulk import "Name, email" per line (header/blank lines ignored, per-line reasons, invites sent), Desk "Build client list" task (client-directory skill); [ ] import from an AD group (needs the lab)
- [x] Weekly partner digest (ADR-053): Mondays (IST) from the daily cron, last week's counts per firm (people using Off Manual, turns, servers healthy, invoices to pay, folder-access requests) to the firm's active admins, once per firm and week (`digest_runs`)
- [x] Report a problem → support queue (ADR-050): Desk tab with preview of exactly what is sent, `support.bundle`/`support.submit` (agent rebuilds the server part; pre-flight + log tail, bounded), `POST /api/agent/support` (strict schema, 20/server/day, ticket ref OM-XXXXXX), staff `/support` page
- [x] Fleet board v1: firm (link) and firm status, health with 1 h staleness, last seen, agent/OpenClaw/Desk/staged versions, seats, problem reports in the last 7 days, count of unhealthy servers, links to firms/billing/reports

### M11 Pilot hardening
- [~] Security review first pass (`docs/SECURITY_REVIEW.md`): items 4–7 done, 5 and 8 fixed in the pass; 1–3 and 8 need the lab; one full-history gitleaks scan before the pilot
- [x] Backup and restore (ADR-060): daily `VACUUM INTO` of agent.db (newest 7), `server-agent restore -from FILE` (service must be stopped; checked copy; previous kept); per-user state = the firm's profile backup (admin guide); [ ] restore drill on the pilot server
- [x] Offboarding archive (F10, ADR-056): state zipped to `backups\offboarded` 15 min after switch-off, removed from the profile, purged after `retentionDays`; cancelled on re-enable; [ ] L11 on the RDS host (FSLogix)
- [x] Firm-facing docs: `docs/guides/employee-quick-start.md`, `docs/guides/admin-guide.md` (only what exists; review with a pilot firm)
- [~] Install runbook written (`docs/guides/install-runbook.md`, manual steps where the MSI isn't built); [ ] time-to-live under 2 hours verified on a pilot

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

### 2026-11-25 13:30: Ship everything: Python, WebView2, static CRT (ADR-072); imported skills approved
- Changed: `release/python/python.lock.json` (Python 3.14.10 embeddable, sha256-pinned, python.exe signed by the PSF; wheels openpyxl 3.1.5, et-xmlfile 2.0.0, pandas 3.1.1, numpy 2.5.5, python-dateutil 4.0.0, tzdata 2026.6 with PyPI's sha256), `tools/release/bundle_python.py` (download, verify, safe-extract, `._pth` with site-packages, no pip, optional smoke test), release step bundles it into the payload, CI job `Bundled Python`; Desk gateway env puts `<v>\python` first on PATH with PYTHONNOUSERSITE/DONTWRITEBYTECODE/UTF8; pre-flight `python_runtime` check; WebView2 Evergreen Standalone Installer (fwlink 2124701, verified Microsoft-signed, v1.3.315.17) downloaded and signature-checked by the release, placed by the MSI in `redist\`, run by `server-agent setup` (`/silent /install`, Authenticode checked first, registry confirmed after) only when `pv` is missing; shared `preflight.WebView2Version`; Desk `.cargo/config.toml` `+crt-static` with a CI check that the binary doesn't import VCRUNTIME140.dll; Excel skill text and provenance updated; both imported skills approved (11/11 approved).
- Tests: bundle + smoke on this machine (workbook with a formula written by openpyxl, read back by pandas; 124 MB); real preflight Python check against the bundle; Go setup WebView2 cases (installed → skipped, missing without installer → note, missing with installer → run once and confirmed, installer error or still missing → setup fails before the service); gateway env PATH test (CI); golangci-lint both OSes 0; actionlint; `verify-skills` 11 approved.

### 2026-11-25 12:00: MSI installer (M8, ADR-071)
- Changed: `installer/OffManual.wxs` (WiX v4+ schema, built with WiX 7.0.1: per-machine, fixed UpgradeCode, MajorUpgrade, payload harvested with `Files` and server-agent.exe named for the custom actions, HKLM Run + Explorer verb components, deferred `setup`/`teardown` custom actions as LocalSystem with a rollback action, `ENROLCODE` hidden); Server Agent `setup` (current junction from its own `versions\<v>` location, enrol unless already enrolled, service through `current`) and `teardown` (service, `current`, later staged versions; ProgramData kept), `app.EnrolledAs`; CI job builds and installs/uninstalls a test MSI on windows-latest and checks junction, service path/account/running/recovery flag, Run key, Explorer verb, and that everything is gone after uninstall; release workflow builds `OffManual-<v>.msi` with the signed manifest inside and attaches it. Runbook rewritten around the MSI (manual fallback kept).
- Tests: Go setup/teardown (current made, enrol once, repair is safe, no code → enrol later, code without URL refused, failed enrolment fails before the service, outside versions refused, teardown removes service/current/staged versions and keeps its own version and unrelated folders, twice harmless) on Windows with real junctions; actionlint; MSI itself verified in CI.

### 2026-11-25 11:00: Starter-pack Excel and Word skills imported (M7, ADR-070)
- Changed: downloaded `ivangdavila/excel-xlsx` and `ivangdavila/word-docx` 1.0.2 from ClawHub's API (`/api/v1/skills/<slug>`, `/versions/1.0.2`, `/api/v1/download`, as OpenClaw 2026.11.6's own client calls them) into an empty scratch folder, nothing executed; every file matched ClawHub's published sha256; vendored as `skills/vendored/ivangdavila__<slug>/` with `SKILL.md` adapted (name = slug, `metadata.openclaw` win32, Excel gated on `python`/`py`, ClawHub install/star/sync lines removed, Off Manual rules added) and `PROVENANCE.md` (source, hashes, licence, changes, checklist); lock entries `pending`. `awspace/pdf` not imported (licence).
- Tests: skill-vet check → no blocking findings (URL warnings are metadata only); `verify-skills` → 11 skills, 9 approved, 13 files match.
- Waiting: Dwahnil approves the two skills; Python decision for Excel.

### 2026-11-25 10:00: Approve on Telegram in place of the PIN (M6, ADR-068 accepted)
- Changed: Server Agent `internal/agent/tgapprove.go` (start/status pipe methods, TelegramDecision; all rules re-checked at the tap; in memory, 60 s, single use, newest wins, 5/hour), store `TelegramUserForSID`, `session.hello.telegramApprove`; Telegram `Bot.SendApproval`/`AnswerCallback`/`EditMessageText`, `allowed_updates` adds `callback_query`, router handles `ua:`/`ud:` callbacks (Bot API 10.5 fields verified); app wires the prompter; shared IPC list + Desk allowlist; Desk `TelegramApprove.tsx` on the PIN screen only.
- Tests: Go (approve unlocks like a PIN; other Telegram account refused; single use; deny; expiry; newer request wins; no day code → not offered/refused; three wrong PINs → refused even mid-request; Telegram off; not linked; switched off mid-request; 5/hour; send failure; bad id; extra field; not offered without a bot; router callbacks incl. junk data and bots; bot request shapes, 64-byte callback data, 200-char answer, buttons removed, allowed_updates); desk 78/78 (waits then approved, denied, gives up, plain reason, offered only when hello says so, never on the daily-code screen); `pnpm run check` green.

### 2026-11-25 09:00: Skills approved
- Changed: on Dwahnil's instruction, all 9 skills set to `approved` (reviewer Dwahnil, 2026-11-25) in `skills/registry.lock.json`; the release workflow now ships them.
- Tests: `verify-skills` → 9 approved, hashes match.

### 2026-11-24 04:10: Skills visible by pack (M5, ADR-069)
- Changed: Server Agent `gateway.lease` returns the employee's `packs`; Desk `gateway::visible_skills` (approved skills in `current\skills\registry.lock.json` whose packs overlap; name = folder slug, vendored `<owner>__<slug>` → slug; strict characters; unreadable → none) and `agents.defaults.skills` in the generated config; `tools/release` `verify-skills` checks each SKILL.md `name` equals its folder slug (all 9 do).
- Tests: Go lease carries packs; Rust visible_skills (approval, pack overlap, two packs, none, junk, empty) + config field (CI); release tools 19/19 (name mismatch refused); `pnpm run check` green. CI for receipts green; `main` at 3f87e03.

### 2026-11-24 03:40: Telegram Approve held for a decision (ADR-068 Proposed)
- Changed: docs only. F8's "Approve on Telegram" for Desk unlock would replace the daily TOTP code (rule 9); recorded options and a recommendation, marked F8 and M6 as waiting on Dwahnil. No code.

### 2026-11-24 03:30: Payment receipts (M9, ADR-067)
- Changed: console `payments.receipt_sent_at` (migration 0012), `emailReceipts` in `lib/admin-mail.ts` (claim → send to active admins → release if none reached; 30-day window; amounts and dates only), called after a manual payment, the Razorpay webhook (route passes the mailer) and the daily cron (`receipts` in its JSON).
- Tests: console (once per payment to active admins, balance then "Paid in full", ₹ and DD-MM-YYYY, released when every send fails and sent next run, nothing without a mailer, old payments skipped; webhook and cron unchanged otherwise); `pnpm run check` green. CI for settings green; `main` at 589341e.

### 2026-11-24 03:10: Desk settings (M4, ADR-066)
- Changed: Rust `settings.rs` (side + optional lock minutes, deny unknown fields, invalid → defaults, atomic save), commands `settings_get`/`settings_set` (save docks the panel again at once), `dock::docked` takes the side; UI `settings.ts` (`effectiveLockMinutes`: own only when shorter than the firm's maximum; `lockChoices`), `SettingsTab.tsx`, idle lock reads the own time on every check.
- Tests: desk 72/72 (helpers, firm limit wins, tab saves side and lock and clears at the limit, plain error, idle lock uses a shorter own time and ignores a longer one); Rust settings (defaults on missing/junk/invalid/unknown, round trip, refused save leaves the file) and left-side dock in CI; cargo fmt. CI for Razorpay green; `main` at 3aa85e6.

### 2026-11-24 02:40: Razorpay payment links and webhook (M9, ADR-065)
- Changed: console `lib/billing/razorpay.ts` (client with Basic auth and the verified request shape; RazorpayError with status + code only; `ensurePaymentLinks` for issued invoices without one; `signatureOk` constant-time hex HMAC; `razorpayWebhook`), issue action and daily cron create links (cron JSON gains `paymentLinks`), route `POST /api/razorpay/webhook`, firm page *Pay online*, invoice list `paymentLinkUrl` (issued only), `.env.example` keys. API facts verified in Razorpay docs and razorpay-node v2.9.8 (research agent).
- Tests: console 143/143 (request shape and Basic header, error carries code not key, unexpected response, amount/reference bounds before calling, env gating; links issued invoices once, drafts/paid never, failure retried, not configured; signature: missing/wrong secret/bad header/changed body/no secret; paid → recorded once with payment id, method and event time, invoice paid; duplicate delivery; other events, unknown link, not captured, bad id ignored; bad JSON 400); `next build` lists the route. CI for the hotkey commit green (first compile of `hotkey.rs`/`dock.rs`); `main` at 60aa498.

### 2026-11-24 02:05: Razorpay slice started (M9)
- Changed: console schema only: `invoices.payment_link_id` (unique) + `payment_link_url`, unique index `payments(provider, provider_ref)`; migration 0011. No code uses them yet; the Razorpay client and webhook follow once the API is verified.
- Tests: `tsc --noEmit` clean; migration generated.

### 2026-11-24 01:50: Docked panel and Ctrl+Alt+O (M4, ADR-064)
- Changed: Rust `dock.rs` (pure: right edge of the work area, full height, 420 logical px, ≤ half the area, ≥ 360), `hotkey.rs` (RegisterHotKey with a NULL window on its own thread + GetMessageW; fifth audited unsafe module; verified in windows-sys 0.61.2; Tauri `current_monitor`/`work_area`/`scale_factor`/`set_size`/`set_position` verified in tauri 2.12.7), `main.rs` docks at start and brings Desk forward on the hotkey; windows-sys feature `Win32_UI_WindowsAndMessaging`.
- Tests: dock math (1080p, 150 %, second monitor with a top taskbar, narrow RDP window, tiny, bad scale) in CI; cargo fmt. CI for running versions pending.

### 2026-11-24 01:30: Who runs which release (M8, ADR-063)
- Changed: agent migration 0011 (`employees.running_version`), pipe `update.report` (strict semver, SID from the pipe; shared IPC list, Desk allowlist), heartbeat `employeeVersions` (active employees only); console `employees.running_version` (migration 0010), heartbeat schema accepts it (≤ 1000, uuid + semver, strict) and updates only this firm's employees, firm page Version column; Desk UpdateNotice reports the running release after each check and the new one after a switch. Also ticked the stale ladder "override UI" item (the `/billing` page has it).
- Tests: Go (report stored, bad versions/extra sid field/unknown caller refused; heartbeat carries active employees only); console 135/135 (stored, other firm's employee untouched, bad version and unknown field refused); desk 67/67 (reports running then new); golangci-lint both OSes 0. CI for the `current` switch green incl. the real service's non-crash recovery flag; `main` at bc1365d.

### 2026-11-24 01:00: `current` switch and Server Agent self-update (M8, ADR-062)
- Changed: `internal/update/current.go` (CurrentVersion via Readlink, SwitchCurrent: next junction + rename swap + rollback, only staged versions with a manifest; Switcher: quiet hours 02–05 IST with no active lease or past a security deadline, never backwards, marks `active`, asks for a restart when the agent changed), junction via `mklink /J` (`link_windows.go`), app `switchLoop` (15 min) cancels Run with ErrRestartForUpdate; **fix**: service install now sets `SetRecoveryActionsOnNonCrashFailures(true)`; before, an agent that stopped itself with an error was not restarted although the code said so; `install` registers through `current`. CI round trip asserts the flag with `sc qfailureflag`.
- Tests: real junctions on Windows (switch, files of the old version untouched, no helper links left, bad/unstaged/traversal versions refused without moving current), switcher (working hours wait, active leases wait, quiet + idle switches and asks for restart, security deadline overrides, never goes back, no restart when the agent didn't change), service path mapping; golangci-lint both OSes 0; actionlint. CI for task roles green; `main` at 09db8da. WiX research: decision added to Waiting on Dwahnil.

### 2026-11-24 00:30: Task roles (M7, ADR-061)
- Changed: console `employees.task_role` (migration 0009), `addEmployee` accepts it, `setTaskRole` + route `POST .../employees/[employeeId]/task-role` (firm-scoped, bumps policy), firm page "Tasks shown first" select, policy carries `taskRole`; agent migration 0010, `SetEmployeeTaskRole` (unknown → none), ApplyPolicy, `session.hello` `taskRole`; Desk `ROLE_TASKS`/`splitTasks` (SKILLS.md §5 defaults), TaskButtons role prop with More tasks, Assistant reads hello.
- Tests: console admin + agent-api (roles, bump, bad values, cross-firm, policy field); Go (policy → store, unknown and cleared roles, hello); desk 67/67 (defaults, nothing hidden, every listed id exists, partner first + the rest under More tasks); lint, typecheck, golangci-lint both OSes 0. Full-history secret scan re-run: 142 commits, no leaks. CI green at 196d8f9; `main` fast-forwarded.

### 2026-11-24 00:05: Full-history scan result
- First full-history gitleaks run (141 commits): 1 finding, `generic-api-key` on a made-up test value (`"0123456789abcdef-cron"`) in `billing-run.test.ts`; not a secret. Ignored by exact fingerprint in `.gitleaksignore`; re-run to confirm clean.

### 2026-11-23 23:50: agent.db backups and restore (M11, ADR-060)
- Changed: store `Backup` (VACUUM INTO) + `IntegrityCheck`; app `dailyBackup` (IST date name, temp + rename, keeps 7 of ours, ignores other files), `backupLoop` (start + hourly), `Restore` (refuses while the pipe exists, copies the backup, opens/migrates/checks it, keeps the current db and its WAL files as before-restore-<UTC>, swaps); CLI `server-agent restore -from FILE`; admin guide Backups; ARCHITECTURE layout; DATA_MODEL.
- Tests: once per IST day, IST date across midnight UTC, keeps 7, foreign files untouched, backup opens and passes the integrity check; restore brings back the backed-up employees and keeps the previous db; refused while running, junk and missing files refused without touching agent.db or leaving the temp copy; CLI usage; golangci-lint both OSes 0.

### 2026-11-23 23:30: Full-history secret scan workflow (security review #9)
- Changed: `.github/workflows/secrets-full-scan.yml` (workflow_dispatch + Mondays 03:00 IST; checkout fetch-depth 0; gitleaks-action v2, whose source passes no `--log-opts` for these events, so every commit is scanned). CI caught `unwrap()` in the new single-instance tests (clippy -D warnings); allowed on the test module as elsewhere.
- Tests: actionlint clean.

### 2026-11-23 23:10: One Desk per session + Explorer "Ask Off Manual" (M4, ADR-059)
- Changed: Rust `instance.rs` (mutex `Local\OffManualDesk`, inbox in `%LOCALAPPDATA%\OffManual\desk\inbox` with temp + rename, auto-reset wake event, drain with size/count/path checks; fourth audited unsafe module; CreateMutexW/CreateEventW/OpenEventW/SetEvent/WaitForSingleObject verified in windows-sys 0.61.2; Tauri `get_webview_window`/`unminimize`/`show`/`set_focus`/`try_state`/`setup` verified in tauri 2.12.7), `main.rs` (second launch forwards and exits; first queues asks, `inbox_take`, `om-inbox` signal); UI `inbox.ts`, Chat `prefill`, Assistant takes asks now and on each signal. ARCHITECTURE F12; runbook `reg add` for the verb; employee quick start.
- Tests: desk 65/65 (newest ask, prompt, Assistant end to end incl. a later signal while on another tab); Rust (command line, path rules incl. device paths and length, post + drain with junk/oversize/relative files, second claim refused and released, a second launch wakes the first via the real event) run in CI; cargo fmt. CI for Request access + digest green; `main` at a955653.
- Half-done / next: MSI registers the verb + autostart; global hotkey (needs the Tauri global-shortcut plugin, L8).

### 2026-11-23 22:40: Request access (M5, ADR-058)
- Changed: agent migration 0009 (`access_requests`), store (RecentDenials from the guard's local audit rows, CreateAccessRequest copies the path from the caller's own row, ≤ 20 open, AccessRequests, Resolve, IsAdmin), pipe methods `access.denials|request|list|resolve` (shared IPC schema, Desk allowlist), `session.hello` carries `admin`; Desk `AccessRequests.tsx` (DenialCards after each reply, Access tab), Chat `onRunEnd`.
- Tests: Go (own denials only, someone else's denial refused, note bounds, extra `target` field refused, single request per denial, admin sees all and closes, non-admin can't, closed twice, week/day windows, 20-open cap, hello admin flag); desk 62/62 (cards only for new unrequested denials, only id + note sent, plain error, admin close, employee view, Assistant end to end); `pnpm run check` green; golangci-lint both OSes 0; cargo fmt. CI for the releases page green; `main` at 65f20ff.
- Then: weekly digest adds "Requests for folder access: N" from the uploaded `access_request` audit counts (resolutions audited as `access_resolved` so they aren't counted); console admin-mail 5/5.

### 2026-11-23 22:10: Releases page and the signing rule (M8, ADR-057)
- Changed: console `releases.authenticode` (migration 0008, from the signed manifest at registration), `promote` refuses unsigned releases beyond ring 0 unless `OM_ALLOW_UNSIGNED_RELEASES=true`, `setFirmRollout` (ring 0–2 + pin; unsigned pins only for lab firms), `releaseAction` (strict schema), `releasesBoard` (rings, servers running/staged per version, firms), route `POST /api/admin/releases`, page `/releases` + links.
- Tests: console 133/133 (unsigned stays in ring 0, lab firm may pin it, allowed by the flag; flag recorded; pin = rollback, clear = follow ring; bad input, unknown version/firm, staff and anonymous refused; board counts); lint, typecheck, `next build` lists the routes. CI for the offboarding archive green; `main` fast-forwarded to 2c61535.
- Half-done / next: publisher pinning once the signing certificate exists.

### 2026-11-23 21:40: Offboarding archive and retention purge (F10, ADR-056)
- Changed: agent migration 0008 (`offboarding` cycles), store methods (DisableEmployee opens a cycle; CancelOffboarding; due/cleanup/purge lists), `internal/offboard` (Archiver: ProfileList registry lookup, zip of `openclaw-state` + `backups` through `os.Root`, removal, purge after retention; audit category `offboarding`; reasons without paths), console `RetentionDays` from the synced policy, ApplyPolicy cancels the cycle when someone is active again, app runs the loop every 15 min.
- Tests: offboard 76.8% (grace, archive contents, originals removed and Desk settings kept, no double archive, purge after retention, re-enable cancels and a later switch-off starts again, active never archived, no profile, failure retried, relative/UNC profile refused, bad SID, purge name check; junctions (real `mklink /J` on Windows) inside the state folder, as the state folder and as the OffManual folder: nothing outside archived or deleted, escape recorded as a failure); real registry lookup for the current user and an unknown SID; console cycle + retention bounds; schema version 8; golangci-lint both OSes 0.
- Half-done / next: L11 on the RDS host; FSLogix profiles (only mounted while signed in).

### 2026-11-23 21:00: Fix: employees switched off in the console fully cleaned up (F10)
- Changed: `console.ApplyPolicy` calls `DisableEmployee` for listed employees with status `disabled`, so their day grant, lease (token hash + DPAPI copy) and Telegram link go on the next sync, not only when the console stops listing them.
- Tests: `TestPolicyDisabledEmployeeIsCleanedUp`; all Go pass; golangci-lint both OSes 0.

### 2026-11-23 20:45: Authenticode check on staged releases (M8, ADR-055)
- Changed: manifest field `authenticode` (Go struct, shared JSON Schema, `sign-manifest build -authenticode`, release workflow passes whether the Azure signing step ran), `internal/update` VerifyAuthenticode (WinVerifyTrustEx, verify then close, pattern from x/sys v0.50.0; non-Windows refuses), Stager checks every .exe/.dll when the flag is set and removes an untrusted staging copy.
- Tests: stager (unsigned binary refused with its path and nothing left in versions; signed passes, only binaries checked; unflagged release never checked); real WinVerifyTrust on this machine accepted a signed git.exe and refused a one-byte-tampered copy; sign-manifest flag; shared-schema 39/39; golangci-lint (errorlint %w, gosec G103 audited) 0; actionlint clean. CI run for the security pass green.
- Half-done / next: pin the publisher (certificate subject) once the Azure signing account exists.

### 2026-11-23 20:10: Security review first pass (M11)
- Changed: `docs/SECURITY_REVIEW.md` (all 9 checklist items with evidence and what remains); Telegram replies sanitized (`internal/telegram/sanitize.go`: 200+ char encoded runs, file:// and localhost/127.0.0.1 links removed, audited); Desk checks `session.hello` every minute while unlocked and stops the gateway with a plain message when the employee is switched off (`Unlock.tsx`, `stopGateway` prop).
- Tests: Go sanitize table + relay end to end; desk 55/55 (disabled stops the gateway, periodic check); golangci-lint both OSes 0.
- Half-done / next: lab items 1–3 and 8; Authenticode check; full-history gitleaks scan.

### 2026-11-23 19:40: Guides (M11)
- Changed: employee quick start, admin guide and install runbook in `docs/guides/`, describing only what is built (hotkey, Explorer right-click and the MSI are marked as coming).
- Tests: none (docs).

### 2026-11-23 19:20: Fleet board v1 (M10)
- Changed: `fleet()` adds firm id/status, OpenClaw/Desk/staged versions and 7-day problem report counts; `/fleet` page uses the shared session helper and links.
- Tests: console fleet (firm status, reports counted only inside 7 days); `next build` ok.

### 2026-11-23 19:00: Firm setup: servers' pre-flight, bulk import, client list task (M10)
- Changed: console `lib/setup.ts` (firmServers: firm-scoped, only warn/fail items; importEmployees: ≤ 200 lines, comma/semicolon/tab, header and blanks ignored, each line through addEmployee so validation, duplicates and invites behave the same), route `POST .../employees/import`, firm page Servers section for admins too, import form; Desk task "Build client list".
- Tests: console 128/128 (problems only, cross-firm 403; added/skipped with line numbers and reasons, duplicate by case, limits); desk 53/53; `next build` lists the route.
- Half-done / next: fleet board v1.

### 2026-11-23 18:30: Fix: enrolment pre-flight bounded
- Changed: `server-agent enroll` now cuts the pre-flight report to the console's enrolment limits (40 results; title 80, detail 200, fix 300). Before, one long detail (e.g. a share error) would have made the console refuse the whole enrolment. Shared `boundReport(report, limits)` for support and enrolment.
- Tests: app limits test for both sets; golangci-lint both OSes 0.

### 2026-11-23 18:20: Emails to firm admins: billing copies and weekly digest (ADR-053)
- Changed: console `lib/admin-mail.ts` (emailBillingNotices with the notice's dedupe key as idempotency key; lastWeek in IST; digestFacts counts only; digestText; weeklyDigests claims the week first), `digest_runs` table (migration 0007), daily cron emails new billing notices and sends digests on Mondays, issuing emails the issued notice; notices take `created_at` from the app clock so "created since" matches.
- Tests: console 125 (once per notice per admin, disabled admins skipped, a bounce doesn't stop others, no mailer → nothing; week boundaries in IST; digest once per week, counts, ₹ and DD-MM-YYYY, closed firms skipped); `next build` ok.
- Half-done / next: setup wizard; fleet board v1.

### 2026-11-23 17:50: Notices (ADR-052)
- Changed: console `notices` table (migration 0006), `lib/notices.ts` (post: staff to one/all firms, firm admin to own firm; feed; billing notices by dedupe key; paid invoices end their notices), issuing and the daily cron create billing notices, policy marks employees whose email is a firm admin's (`admin`), `GET /api/agent/notices`, `POST /api/admin/notices`, firm page form; agent migration 0007 (`employees.is_admin`), store notices (mirror active list, per-SID dismissals), `notices.list`/`notices.ack`, Syncer mirrors notices, client drops malformed notices; Desk `Notices.tsx` banner.
- Tests: console 120/120 (roles, windows, all-firm vs own, billing stages once with ₹ and DD-MM-YYYY, paid ends them, feed and admin flag over a signed request); Go (audience filtering, dismissals per person, mirror removes, admin flag from policy, malformed dropped); desk 52/52; golangci-lint both OSes 0.
- Half-done / next: email copies of billing notices (Resend); weekly partner digest.

### 2026-11-23 17:10: Usage counts (ADR-051)
- Changed: guard `usage.ts` (UsageMeter: turns from `agent_end`, input/output tokens from `llm_output` usage, verified in the 2026.11.6 hook types; flush every 60 s and on stop; failed sends kept), guard bridge allows `usage.add`; agent migration 0006 (`usage_daily`), `usage.add` (bounds, caller SID), Syncer uploads complete IST days once (`usage_sent_through`, a week of backlog), console client `SendUsage`; console `POST /api/agent/usage` (strict, complete days only, other firms' employees ignored, a day's totals replace on retry). Billing's seat activity (`peak_active`) and the usage line now have a real source.
- Tests: guard 73/73 (junk ignored, failed flush kept); Go usage.add (accumulates per day, bounds, missing fields, unknown caller), upload (yesterday sent, today not, never twice), schema version 6; console 116/116 (store, retry replaces, cross-firm ignored, today refused, unknown field, negative); golangci-lint both OSes 0.
- Half-done / next: confirm in the lab that `llm_output` fires with usage for the firm's model provider.

### 2026-11-23 16:35: Task buttons (M7) + CI flake fix
- Changed: Desk `tasks.ts` (9 tasks, file-safe client names, FY list, plain missing-input message), `TaskButtons.tsx`, Chat `queued` prop (a task's request is sent once as if typed), Tasks tab; skills' output names aligned with SKILLS.md §5 (hashes refreshed); Desk Rust test servers read the full request head before replying (a Windows reset made `readiness_poll_against_a_local_server` flaky in CI run 45036423222).
- Tests: desk 50/50 (prompts name skill + file, helpers, Assistant end to end: missing inputs, then one chat request).
- Half-done / next: role-based defaults; usage reporting.

### 2026-11-23 16:05: India pack skills (M7)
- Changed: six skills `skills/offmanual/{gstr2b-vs-books,ais-26as-vs-books,tds-checks,notice-reply-draft,doc-chaser,tally-mis}/SKILL.md` (instruction-only, read-only, outputs in the client's folder with the naming rule, ₹ Indian grouping and DD-MM-YYYY, stop on Access Denied, never touch portals or contact anyone; tax rates and limits come from the firm's own reviewed tables, not from the model's memory); lock entries `pending`.
- Tests: skill-vet check — no blocking findings for any; `verify-skills` OK (9 skills, 0 approved).
- Half-done / next: Dwahnil + CA review each SKILL.md; task buttons that start these skills.

### 2026-11-23 15:45: Report a problem (F11)
- Changed: agent `support.go` (bundle preview, submit with description ≤ 500 UTF-16 units, desk info flat and small, plain errors, audit), app `support.go` (pre-flight bounded to 20 s and to the console's limits, last 200 log lines, rune-safe cuts, empty array instead of null), console client `SubmitSupport`; IPC schema + Desk allowlist `support.submit`; console migration 0005 (`support_tickets.ref`, `description`, `bundle`), `lib/support.ts` (strict zod schema, daily cap, unique ref, employee linked only within the firm), route, `/support` page; Desk `ReportProblem.tsx` tab. ADR-050.
- Tests: Go agent (preview, desk validation, rebuilt server part, user/network errors, limits, unknown caller), app (tail, bundle shape matches the console, cut), console client; console 115/115 (ref, staff-only list, unknown fields/oversize/paths field refused, cross-firm employee not linked, daily cap); desk 47/47; golangci-lint both OSes 0. Caught before shipping: pre-flight `skip` status and a null log tail would have been refused by the console.
- Half-done / next: usage reporting (needs OpenClaw usage source verified), notices.

### 2026-11-23 15:05: Admin authenticator reset (ADR-049)
- Changed: console `employees.totp_reset_at` (migration 0004), `resetAuthenticator` (firm-scoped, active employees only, bumps the policy), route `POST .../employees/[employeeId]/reset-authenticator`, firm page button with confirm; agent policy includes `totpResetAt`; Server Agent migration 0005 (`employees.totp_reset_applied_at`), `store.ApplyTOTPReset` (clears secret, enrolment, counter, recovery codes, day grant; only for a newer request), ApplyPolicy applies it.
- Tests: console 112/112 (roles, cross-firm, invited refused, policy bump, policy carries the timestamp); Go sync test (applied once, a re-enrolled phone isn't reset again by the same request, a newer request resets, bad timestamps ignored), schema version 5; golangci-lint both OSes 0. A first attempt put the column on `firm_admins` (anchor matched the wrong table); caught by typecheck, migration regenerated.
- Half-done / next: Report a problem (F11).

### 2026-11-23 14:35: Gateway keeper: idle stop, start on use, crash restart (M4, F4 step 5)
- Changed: Desk UI `keeper.ts` (GatewayKeeper with injectable start/stop/status and clock; `keptGateway` wraps chat/review calls so a resting or crashed gateway starts first; one shared start for concurrent uses), Assistant ticks it every 30 s, reads `gatewayIdleStopHours` from policy.get, shows resting/starting/stopped notes.
- Tests: desk 44/44 (rest after idle, activity postpones, start on send, crash restarts capped at 3/hour then still startable by a message, failed start message, shared start, policy bounds; Assistant end to end with fake timers).
- Half-done / next: lab confirms the gateway's memory footprint per user (sizing the default 4 h).

### 2026-11-23 14:10: Invoice PDF (M9)
- Changed: dependency pdf-lib 1.17.1 (pure JS, no install scripts; API checked in its .d.ts), `lib/billing/pdf.ts` (pure `invoiceLayout` + `renderInvoicePdf`; WinAnsi-safe text, "Rs." amounts), `invoicePdf` loader (firm-scoped; firm admins only issued/paid), PDF route, links on the firm and billing pages, seller name/address config (`OFFMANUAL_LEGAL_NAME`, `OFFMANUAL_ADDRESS`).
- Tests: console 111/111 (content: GSTINs, place of supply, SAC, split, dates DD-MM-YYYY, words; IGST; draft wording; unregistered buyer; Devanagari name doesn't break rendering, PDF loads back with 1 page and title; access: draft staff-only, issued for own admin, cross-firm 403, unknown firm).
- Half-done / next: Razorpay payment links (keys); invoice email to firm admins.

### 2026-11-23 13:40: Superadmin billing page (M9)
- Changed: `billingBoard` (superadmin; invoices across firms with names, money as strings), `app/billing/page.tsx` + `forms.tsx` (run month, issue, payment with strict rupee → paise conversion, override, refresh), link from `/firms`.
- Tests: console 107/107 (board roles, string money; rupee conversion incl. 0, 3 decimals, negative, commas); `next build` lists `/billing`.
- Half-done / next: invoice PDF; Razorpay (keys).

### 2026-11-23 13:10: Invite emails (M3)
- Changed: `lib/email.ts` (Mailer interface, Resend sender verified against resend.com docs: POST /emails, Bearer key, from/to/subject/text, Idempotency-Key; status-only errors; `mailerFromEnv` off until `RESEND_API_KEY` + `OM_EMAIL_FROM`; invite text with the `/bind` link, names only), `addEmployee` sends and records `sent_at` and returns `inviteSent`, `resendInvite` + route `POST .../employees/[employeeId]/invite` (firm-scoped, only for people not yet signed in), UI message + button.
- Tests: console 105/105 (request shape, error status, env gating, invite text; add sends once with an idempotency key, failure keeps the employee, no mailer → not sent, resend after a failure, cross-firm refused, already signed in refused); `next build` lists the route.
- Half-done / next: superadmin billing UI; WhatsApp invites (v2).

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
