# Progress

<!-- Claude Code: keep this file short enough to scan in 30 seconds. Newest session log entry first. Move finished milestones' detail into the Done summary when they are complete. -->

## Current focus

M0 Scaffold, then M1 Research + lab spikes.

## Next step

Follow BUILD_PROMPT.md §4 "First session".

## Waiting on Dwahnil

- [ ] Empty GitHub repo `offmanual-desk` (private) and push access for this machine
- [ ] Windows Server 2022 VM with RDS Session Host role, 3 test domain or local users, a file share with different NTFS rights per user (needed for M1 lab)
- [ ] TallyPrime installed on the lab VM (educational mode is enough)
- [ ] Later (M3+): Postgres database URL, Vercel project, Google OAuth client, Microsoft Entra app registration, Resend API key
- [ ] Later (M6): Telegram bot token for the lab firm
- [ ] Later (M8): code-signing certificate (or Azure Trusted Signing account) and the ed25519 release-signing key stored as GitHub secrets
- [ ] Later (M9): Razorpay test keys; Off Manual GSTIN, state, SAC code confirmed with the CA

## Milestones

### M0 Scaffold
- [ ] Hook scripts tested on this machine (node 18+, git on PATH)
- [ ] Monorepo layout per ARCHITECTURE.md § Repository layout
- [ ] Hello-world build per app (Go service, Tauri app, Next.js console, two TS plugins)
- [ ] Lint, format, type-check, test configured per app
- [ ] `.gitignore`, `.env.example` per app
- [ ] CI: Go + Rust on windows-latest, console + plugins on ubuntu-latest
- [ ] CLAUDE.md "Commands" section filled in

### M1 Research + lab spikes
- [ ] OpenClaw version pinned (ADR)
- [ ] OPENCLAW_NOTES.md §1–10 verified with links/paths
- [ ] Assumptions that broke → Proposed ADRs
- [ ] `lab/` scripts for L1–L10 + `lab/README.md` runbook
- [ ] Lab results recorded (needs Dwahnil) and ADRs updated

### M2 Server Agent core
- [ ] Windows service install/uninstall/start/stop, structured logs
- [ ] SQLite local store + migrations (DATA_MODEL.md §2)
- [ ] Named pipe JSON-RPC server with OS-derived caller SID
- [ ] Enrollment with console (keypair, signed requests), heartbeat
- [ ] Policy fetch → `policy.json` (read-only to users)
- [ ] Daily code (TOTP) + PIN verification, lock state, lockout
- [ ] Port + token leases for gateways
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
- [ ] Gateway lifecycle: lease, start as user, health, stop on idle, restart
- [ ] Docked chat panel + global hotkey
- [ ] Explorer right-click "Ask Off Manual"
- [ ] Notifications area (updates, billing, admin)

### M5 Guard plugin
- [ ] Lock + licence enforcement on every inbound turn
- [ ] Skill packs from policy (AD groups + console overrides)
- [ ] Access-denied handling + Request access
- [ ] Review queue (approve all / edit / reject), Desk UI
- [ ] Audit events to Server Agent
- [ ] Telegram policy enforcement (off / text / files)

### M6 Telegram
- [ ] Server Agent long-polls firm bot, routes by linked Telegram user ID
- [ ] channel-relay plugin
- [ ] Link via deep link one-time code
- [ ] Unlock via Telegram (button + `/unlock <code>`)
- [ ] Wake stopped gateway on message (depends on L6)

### M7 Skills
- [ ] Registry tooling: vendor, lock, scan, sign, build pack
- [ ] Starter pack imported and reviewed (SKILLS.md §3)
- [ ] Client directory skill + admin scan
- [ ] Task buttons v1 (SKILLS.md §5)
- [ ] India pack v0 (SKILLS.md §4)

### M8 Updates
- [ ] GitHub Actions release workflow (build, test, scan, sign, manifest, upload, register)
- [ ] Rings + firm pins in console
- [ ] Server Agent stage + verify + report
- [ ] Desk notice + restart-to-update + security deadline
- [ ] Rollback

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

### 2026-11-22: Kit created
- Changed: initial memory files, docs, hooks and skills from the Off Manual × OpenClaw plan.
- Next: BUILD_PROMPT.md §4.
