# Changelog

All notable changes. Format: Keep a Changelog; versions follow SemVer. Claude Code adds a line under **Unreleased** for every change; `node tools/release/cli.mjs prepare <version>` moves them under the new version (ADR-017).

## Unreleased

### Added
- Request access: when the assistant is refused a folder, Desk offers a note to the firm's admins, who see and close requests in their own Desk. Folder names stay on the firm's server.
- Console releases page: move a release to the pilot or all firms, set a firm's ring, pin a firm to a version (rollback). Only Authenticode-signed releases leave the lab ring.
- Guides: employee quick start, firm admin guide and install runbook.
- Fleet board shows firm status, all component versions, pending updates and recent problem reports per server.
- Setup: the firm page shows what each server's checks found and how to fix it, and admins can add many people at once by pasting "Name, email" lines; Desk has a "Build client list" task.
- Firm admins get billing reminders by email and a Monday summary (people using Off Manual, questions handled, server health, invoices to pay).
- Notices in Desk: Off Manual announcements, the firm's own messages, and billing reminders for firm admins (issued, due soon, due today, overdue), each dismissable.
- Usage counts: each employee's daily turns and tokens (numbers only) reach the console for seat activity and usage billing.
- Desk Tasks tab: one-click jobs (GSTR-2B vs books, 26AS/AIS vs books, ledger scrutiny, notice reply draft, missing documents, month-end MIS, bank reco, summarise a document, due this week) that ask for the client and period.
- India pack drafts (waiting for review): GSTR-2B vs books, AIS/26AS vs books, TDS checks, notice reply draft, document chaser, Tally MIS.
- Report a problem: Desk shows exactly what will be sent (versions, server checks, the Server Agent's own log lines; never files or chats), adds the employee's short description and returns a reference number.
- Firm admins can reset an employee's authenticator from the console when the phone and recovery codes are both lost; the employee sets it up again in Desk.
- Desk stops an unused assistant after the firm's idle hours to save server memory, starts it again on the next message, and restarts it if it crashes.
- Invoice PDFs with both GSTINs, place of supply, SAC codes, the GST split and the total in words.
- Console billing page for Off Manual: make monthly drafts, issue invoices, record payments and override a firm's status with a reason.
- Invite emails: adding an employee emails them how to start (when email is configured), with a "Send invite again" button.
- Console pages for firms: employees (add, switch off), skill packs, firm settings, server enrolment codes and invoices.
- Updates: Desk shows "Off Manual <version> is ready. Restart to update." Each person switches when it suits them; if the new version fails, Desk goes back to the previous one with their data restored. Security updates install themselves after their deadline.
- Firms can require today's authenticator code before anyone approves an item in the Review tab.
- Recovery codes: shown once when you set up your authenticator; if you lose your phone, one code lets you set up a new one.
- Desk repairs the assistant's data automatically when a new OpenClaw version needs it (backup first, then repair, then one retry).
- Billing: monthly draft invoices from each firm's contract, issuing with numbers per financial year (OM/FY2026-27/0001), manual payments, and firm status following the payment ladder (with a reasoned override).
- Desk locks itself after the firm's idle time without keyboard or mouse use in your Windows session.
- First sign-in: a new employee signs in with their work Google or Microsoft account and types the code it shows into Desk; Off Manual then knows their Windows account.
- Desk shows a plain notice when the firm's bill is overdue, and a paused message instead of the assistant when the service is paused.
- Skill packs: the assistant can only use the tools of the packs the firm gave each employee (Telegram: core plus the packs the firm allows there). Pack contents ship inside the signed release.
- Licence: when a firm is suspended or closed, or the server hasn't reached Off Manual for over 7 days, employees get one plain message in Desk and Telegram instead of answers; overdue firms keep working with a notice.
- Desk: Telegram tab shows a QR code to link your phone's Telegram in one scan.
- Desk: chat with your assistant (replies appear as they are written; Stop button) and a Review tab to approve, edit or reject what the assistant asked to do.
- Review queue: Off Manual can now only ask to delete files; the request waits until a person approves it (approve, edit, reject, approve all), runs once, and reports what happened. Delete commands that would skip the queue are blocked.
- Project kit: CLAUDE.md, PROGRESS.md, DECISIONS.md, docs/, Claude Code hooks and skills.
- Monorepo scaffold: pnpm workspace (console, desk, shared-schema, guard, channel-relay), Go workspace (server-agent, sign-manifest), Tauri 2 Desk with React UI, Next.js console with `/api/health`.
- Server Agent `version`/`help` commands with build info injected at link time.
- Release manifest library (`apps/server-agent/pkg/manifest`): ed25519 signature over exact manifest bytes, deterministic payload zip, strict parsing, zip-slip and zip-bomb safe extraction, directory verification.
- `tools/sign-manifest` CLI: keygen, build, sign (key only from env), verify.
- `tools/release` CLI: prepare (CHANGELOG roll + version bump), check-tag, notes, verify-skills.
- Shared JSON Schemas for the release manifest, its signature and pipe messages, with a golden fixture tested from both TypeScript and Go.
- Indian formatting helpers: ₹ with Indian grouping from integer paise, DD-MM-YYYY in IST, FY labels, invoice numbers.
- Guard plugin: access-denied classifier (EPERM/EACCES/Win32/HRESULT/text), OpenClaw packaging (`openclaw.plugin.json`, built `dist/plugin.js`) and an install block, typed against `openclaw@2026.11.6`.
- CI workflow: format, lint, typecheck, tests, Go on Windows and Linux, golangci-lint, Rust fmt/clippy/test on Windows, lab-script parsing, actionlint, gitleaks.
- Release workflow: tag-triggered build, pinned Node + OpenClaw with hash checks, skills-lock check, Authenticode (when configured), signed manifest, GitHub pre-release, optional release store and console registration; dry-run mode.
- Lab validation scripts L1–L10 with a runbook for the Windows Server 2022 RDS lab.
- Automated tests for the Claude Code memory hooks.
- Server Agent TOTP verification (RFC 6238; one-step clock tolerance; each code usable once).
- Server Agent local database (SQLite, embedded migrations) with employees, day grants, lock state, audit and stable port leases.
- Server Agent JSON-RPC over the named pipe: caller identity from the Windows process token, strict parsing, plain error messages with correlation IDs, no request content in logs.
- Server Agent pipe methods: sign-in state, authenticator enrolment, daily code, PIN, step-up, lock, gateway port/token leases, audit, policy.
- Server Agent runs as a Windows service (install/uninstall commands, automatic restart on failure) or in the foreground; JSON logs.
- TOTP secrets encrypted with Windows DPAPI; data folder restricted to SYSTEM and Administrators.
- `server-agent preflight`: checks a server is ready (Windows version, memory, disk, Remote Desktop, WebView2, TallyPrime, bundled Node, Clients share, internet access, clock) with a plain fix for each problem.
- `server-agent bridge`: lets Node-based clients talk to the Server Agent pipe safely.
- Signed requests between the Server Agent and the console (ed25519, 5-minute window, replay protection), with a test vector both sides must match.
- Console database schema (firms, servers, employees, invites, skill packs, policies, releases, usage/audit counts, support) with migrations.
- Console agent API: server enrolment with one-time codes, heartbeat, firm policy (cached with ETag), daily audit counts.
- `server-agent enroll`: registers a server with the console; the agent then reports every 15 minutes and keeps its employee list in step with the console (removed employees are switched off).
- Console sign-in with Google or Microsoft, followed by a mandatory authenticator code (QR set-up on first sign-in); sessions end after 12 hours or when the user is disabled.
- Console management API: firms, one-time server enrolment codes, employees (add, list, switch off), skill-pack grants by employee or AD group, firm policy; firm admins only ever see their own firm.
- Console fleet board: every server with red/amber/green status, last seen, version and active seats.
- Desk: first-run authenticator set-up with a QR code, PIN set-up, unlock with PIN or today's code, and lock; it talks to the Server Agent only after confirming the service is genuine.
- Guard plugin: refuses every turn while Off Manual is locked (and when it can't check), stops a task the moment Windows denies access to a file (no retries, no other paths), records the denial in the firm's local audit log, and blocks all skill/plugin installs.
- Desk starts the employee's own assistant after unlock (on a leased port with a private token, locked-down settings) and stops it when Desk closes.
- Billing engine: monthly invoice amounts for setup, AMC, per-seat (prorated or peak, with price bands), AI usage and discounts; GST split by state; totals in words; the overdue → restricted → suspended ladder with manual override.
- Updates: the release workflow can register releases with the console; firms receive releases by rollout ring (or a pinned version); the Server Agent downloads, verifies the signature and every file, and unpacks the new version alongside the running one.
- Skill vetting tool and the first Off Manual skills (client directory, compliance calendar, ledger scrutiny), held back from releases until reviewed.
- Server Agent can talk to an employee's assistant using OpenClaw's secure handshake (groundwork for Telegram).
- Telegram: one firm bot for everyone; employees link their account from Desk with a one-time link, then message their assistant (text only by default; files refused); /unlock with today's code; replies say "open Desk" when the assistant isn't running.
- Server Agent PIN rules (4–8 digits, obvious PINs refused), argon2id PIN hashing, and lockout rules (3 wrong PINs → daily code; 5 wrong codes → 15-minute lockout + admin alert).

### Changed
- OpenClaw pinned to 2026.11.6 and Node runtime to 24.22.3 (ADR-019).
- ARCHITECTURE flows F4–F7 rewritten from verified OpenClaw behaviour; several assumptions now carry Proposed ADRs (020–028).

### Fixed
- Enrolling a server no longer fails when a pre-flight check has a long message.
- Memory hooks: removed a dead initial assignment flagged by ESLint.
- CI: shellcheck findings in the release workflow; secret scan no longer fails when artifact storage is full.

### Security
- A switched-off employee's assistant data is archived on the server (administrators only) 15 minutes after switch-off, removed from their profile, and deleted after the firm's retention period. Planted links can't redirect the clean-up.
- Employees switched off in the console now lose their lease, day grant and Telegram link on the next sync, not only their status.
- Releases signed with Authenticode are only staged when every program file's signature checks out with Windows.
- Telegram replies can no longer carry encoded file dumps or links to files on the server.
- When an employee is switched off, Desk stops their assistant within a minute.
- Server Agent pipe ACL tightened to explicit rights plus first-instance flag and server identity check, after the lab self-test showed generic write allows pipe squatting (ADR-029).
- Gateway config must set `gateway.auth.rateLimit.exemptLoopback: false`; OpenClaw's default exempts loopback, which on an RDS host means every session (ADR-021).
- Install scripts of the OpenClaw SDK dependency disabled in the workspace; release payload installs OpenClaw with `--ignore-scripts` from a lockfile.
