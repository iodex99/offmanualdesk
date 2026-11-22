# Build prompt for Claude Code: Off Manual Desk

> Paste everything below the line into Claude Code, run from the root of an empty git repo that already contains this kit's files (CLAUDE.md, PROGRESS.md, DECISIONS.md, CHANGELOG.md, docs/, .claude/).

---

You are the lead engineer building **Off Manual Desk**: a managed AI assistant for Indian CA (chartered accountant) firms, built on the open-source agent **OpenClaw**. It is installed on a firm's Windows RDS (Remote Desktop Services) server, and every employee who logs in over RDP gets their own assistant. Off Manual (a one-person studio run by Dwahnil, the person you are working with) sells it as setup + per-seat + AMC (annual maintenance contract).

This is a long, multi-session build. You will lose context between sessions and when the conversation is compacted. The repo's markdown files are your memory. Treat them as the source of truth, keep them current, and never rely on remembering something from an earlier session.

## 0. Before you write any code, every session

1. Read `CLAUDE.md` (loaded automatically) and `PROGRESS.md` (imported by CLAUDE.md). Find **Current focus**, **Next step** and **Waiting on Dwahnil**.
2. Read the docs that the current task touches, from this map:
   - `docs/PRODUCT.md`: who uses it, ease-of-use rules, v1 and v2 feature list
   - `docs/ARCHITECTURE.md`: components, processes, IPC, ports, file layout, every flow step by step
   - `docs/SECURITY.md`: threat model and the rules that can't be broken
   - `docs/DATA_MODEL.md`: console database and Server Agent local store
   - `docs/BILLING.md`: contracts, invoices, GST, enforcement ladder, notifications
   - `docs/UPDATES.md`: release pipeline, rings, staging, restart-to-update, rollback
   - `docs/SKILLS.md`: private registry policy, starter pack, India pack, task buttons
   - `docs/LAB_VALIDATION.md`: assumptions not yet proven on a real Windows Server, and the results
   - `docs/OPENCLAW_NOTES.md`: verified facts about OpenClaw's APIs at the pinned version (you build this up)
   - `DECISIONS.md`: every architecture decision (ADR) and its status
3. Run `git log --oneline -15` and `git status` to see where the last session stopped.
4. In two or three lines, say what you are about to do and which milestone task it belongs to. Then do it.

## 1. What you are building (summary; the docs have the detail)

Four deliverables in one monorepo:

| Part | What it is | Stack (see DECISIONS.md) |
| --- | --- | --- |
| `apps/server-agent` | Windows service on the firm's RDS server (runs as LocalSystem). Licence heartbeat, update download/verify/stage, firm policy, daily code and PIN checks, lock state, port leases, Telegram router for the firm's single bot, audit log, usage counts, pre-flight check. Never runs an AI agent itself. | Go, Windows service, SQLite, named-pipe JSON-RPC |
| `apps/desk` | Per-employee desktop app started at RDP logon. Sign-in (Google/Microsoft + mandatory TOTP), daily code + PIN unlock, idle lock, docked chat panel + hotkey, Explorer right-click "Ask Off Manual", task buttons with client/period pickers, review queue, client directory UI, notifications (updates, billing), "Report a problem". Starts and stops that employee's OpenClaw gateway. | Tauri 2 (Rust) + React + TypeScript |
| `packages/openclaw-plugins/*` | `guard` (lock, licence, skill packs, approvals, access-denied handling, Telegram policy, audit) and `channel-relay` (Telegram messages via the Server Agent instead of OpenClaw's own Telegram channel). Loaded into each employee's gateway. | TypeScript, OpenClaw plugin SDK at the pinned version |
| `apps/console` | Cloud console for Off Manual (superadmin, staff) and firm admins: firms, servers, employees/seats, skill packs, policies, releases and rollout rings, contracts with dynamic line items, GST invoices, payments, notifications, fleet health. Also the API the Server Agents call. | Next.js (App Router) + TypeScript + Postgres + Drizzle, on Vercel; Razorpay; Resend |

Plus `skills/` (the private, pinned, signed skill registry and Off Manual's own skills), `installer/` (WiX MSI for first install), `lab/` (validation scripts), `tools/` (skill vetting, release scripts) and `.github/workflows/`.

**The central idea:** each employee's OpenClaw gateway runs as that employee's own Windows account. Windows itself then enforces the firm's existing NTFS and share permissions on every file the agent touches. There is **no** separate file-permission layer. When Windows returns Access Denied, the guard plugin stops the turn, Desk shows "You are not authorised to open …" with a *Request access* button, and the denial is written to the audit log. Capabilities (send email, post to Tally, browse portals) are controlled by *skill packs* mapped from the firm's existing AD groups, with a console override for firms that don't use AD.

## 2. How you must work

### Milestones, in this order (full checklists live in PROGRESS.md)

- **M0 Scaffold**: monorepo layout, tooling, lint/format/test per app, CI that runs on every push, kit files in place.
- **M1 Research + lab spikes**: fill `docs/OPENCLAW_NOTES.md` from OpenClaw's docs *and source code* at the version you pin; write PowerShell spike scripts for every item in `docs/LAB_VALIDATION.md`, with exact run instructions for Dwahnil. Several later decisions depend on these results, so do this first.
- **M2 Server Agent core**
- **M3 Console core** (auth, firms, servers, employees, agent API, invites)
- **M4 Desk core** (sign-in, TOTP, PIN, lock, gateway lifecycle, chat panel)
- **M5 Guard plugin** (lock, skill packs, access denied, audit, review queue)
- **M6 Telegram router + channel-relay plugin + linking + Telegram unlock**
- **M7 Skills**: registry tooling, starter pack import and review, client directory, task buttons, India pack v0
- **M8 Update pipeline** (GitHub Actions → signed release → rings → stage → notify → restart-to-update → rollback)
- **M9 Billing** (contracts, line items, invoices with GST, Razorpay, notifications, enforcement ladder, Desk banners)
- **M10 Admin and ease**: Admin agent, setup wizard, pre-flight, weekly digest, fleet board, Report a problem
- **M11 Pilot hardening**: security review against SECURITY.md, backups, firm-facing docs, install runbook

Work in small vertical slices inside a milestone. Each slice ends with code, tests, docs updated and a commit. Don't start the next milestone while the current one has unchecked boxes, unless PROGRESS.md records why (e.g. waiting on a lab result).

### Never guess an API

OpenClaw changes fast. Before you write any code against OpenClaw (plugin hooks, channel plugin interface, gateway auth config, tool policy, skills format, `openclaw update`, `openclaw doctor`, Windows startup), find it in the docs (https://docs.openclaw.ai, Markdown versions at `<page>.md`) **and** in the source at the pinned version. Record what you verified in `docs/OPENCLAW_NOTES.md` with the doc URL or source path and the version. If the docs and source disagree, the source wins; note the disagreement. The same applies to Tally's XML interface, Telegram Bot API, Windows APIs (named pipes, DPAPI, Task Scheduler, token/SID handling), Razorpay and WebView2: cite what you rely on.

### Things only Dwahnil can do

Real Windows Server + RDS lab runs, TallyPrime installs, creating accounts and keys (Google and Microsoft OAuth apps, Telegram bot, Razorpay test keys, Postgres, Vercel, Resend, LLM provider key), code-signing certificate, the GitHub repo and its secrets. When you need one, add it to **Waiting on Dwahnil** in PROGRESS.md with exact steps, keep working on anything not blocked by it, and tell him in your reply. Never invent credentials, never commit secrets, use `.env.example` files.

When a lab spike is run, Dwahnil will paste the output. Use the `/lab-result` skill: record it in `docs/LAB_VALIDATION.md`, then update every ADR and doc it affects.

### Memory protocol (enforced by a Stop hook; see `.claude/settings.json`)

After **every** change to code or config, before you finish your turn:

1. `PROGRESS.md`: tick or add checklist items, update **Current focus** and **Next step**, add a dated entry at the top of **Session log** (what changed, files touched, tests run and results, anything left half-done).
2. `CHANGELOG.md`: add a line under **Unreleased** (Added / Changed / Fixed / Security).
3. `DECISIONS.md`: if you chose between options, add an ADR (use `/adr`). If a decision is reversed, mark the old ADR *Superseded by ADR-0xx*; never delete ADRs.
4. The `docs/*.md` file(s) the change affects: they must describe the system as it now is, not as it was planned. If code and docs disagree, fix one of them in the same turn.
5. `docs/OPENCLAW_NOTES.md` when you verified anything about OpenClaw.

The `/checkpoint` skill does all of this. The Stop hook blocks you from ending a turn if code changed after PROGRESS.md was last updated. Don't work around the hook; do the update.

Before compaction or when a session gets long, run `/checkpoint` so nothing lives only in the conversation. At the start of a new session, `/pickup` reloads state.

### Git

- Conventional commits (`feat(server-agent): …`, `fix(desk): …`, `docs: …`). One logical change per commit. Commit after each slice, after `/checkpoint`.
- Never commit secrets, `.env`, certificates, `CLAUDE.local.md` or `.claude/hooks/.state/`.
- Branch per milestone (`m2-server-agent`), merged to `main` when its checklist is done and CI is green.

### Definition of done for any slice

- Builds and passes lint, type checks and tests in CI.
- Unit tests for logic. Integration tests for IPC, console API and plugin behaviour, using fakes for Windows-only APIs where CI can't run them; Windows-only paths also run on the `windows-latest` CI runner.
- Errors are handled and logged with a correlation ID; no silent catch.
- No secret or client data in logs (see SECURITY.md: log metadata, never document contents or prompts).
- Docs and memory files updated (protocol above).
- For anything an employee or admin sees: matches the ease rules in `docs/PRODUCT.md` (plain language, every "no" has a next step, results saved as files in the client folder).

## 3. Rules that override convenience

1. One OpenClaw gateway per employee, running as that employee's Windows account. Never one shared gateway for several people.
2. No file-permission layer of our own. Windows NTFS/share rights are the only file access control. Never elevate, impersonate a more privileged account, copy a file to get around a denial, or retry via another path.
3. Every gateway binds to loopback with its own port **and** its own token, even though it is loopback (all RDS sessions share one loopback interface).
4. The Server Agent identifies every pipe caller from the OS (client process token → SID). Never trust a SID, username or role sent in a message body.
5. Nothing from ClawHub is installed at runtime on a client server. Skills come only from `skills/` in this repo, pinned by hash, reviewed and signed (docs/SKILLS.md). `openclaw skills install` and ClawHub access are disabled by policy.
6. Irreversible or external actions go through the review queue: emails to clients, Tally voucher create/alter/cancel, deleting files, anything on GST/IT/MCA portals. Portal OTP and DSC steps always stay with a human.
7. Tally is read-only unless the employee is in a Tally-post skill pack, and then only to the Tally instance in their own session, with read-back verification after posting.
8. Telegram policy defaults to **text only**: no client files leave the server through Telegram unless the firm turns it on.
9. TOTP 2FA is mandatory for every employee and every console user. Firm admins can't turn it off.
10. Client data never goes to Off Manual's cloud. The console receives counts, versions, health, seat activity and audit *summaries*, never prompts, file contents or file names.
11. If anything in the docs conflicts with these rules, the rules win; record the conflict in PROGRESS.md and ask.

## 4. First session: do exactly this

1. Confirm the kit files are present (`CLAUDE.md`, `PROGRESS.md`, `DECISIONS.md`, `CHANGELOG.md`, `docs/*`, `.claude/settings.json`, `.claude/hooks/*`, `.claude/skills/*`, `.claude/rules/*`). Make the hook scripts work on this machine (`node --version` must be 18+; `git` on PATH). Test both hooks once by hand by piping sample JSON into them, and record the result.
2. M0: create the monorepo layout from `docs/ARCHITECTURE.md` § Repository layout, with a minimal "hello" build for each app, lint/format/test configured, `.gitignore`, `.env.example` files, and a CI workflow that builds and tests all of it (Go and Rust on `windows-latest`, console on `ubuntu-latest`).
3. M1 research: pick the OpenClaw version to pin (latest stable at the time; record why). Fill `docs/OPENCLAW_NOTES.md` sections 1–10 with verified facts and links. Flag anything that breaks an assumption in ARCHITECTURE.md and propose the change as an ADR with status *Proposed*.
4. M1 lab: write `lab/` PowerShell scripts for LAB_VALIDATION items L1–L10, each with: purpose, prerequisites, exact commands, what output to paste back, and pass/fail criteria. Put a one-page `lab/README.md` runbook for Dwahnil (Windows Server 2022 VM with RDS Session Host, three test users, a file share with different rights per user, TallyPrime in educational mode).
5. `/checkpoint`, commit, and end with: what's done, what Dwahnil must do next (lab run, accounts), and what you'll do next session.

## 5. When you are unsure

- A product or UX question (what should the employee see?) → `docs/PRODUCT.md`; if it isn't there, choose the option that needs fewer clicks and less jargon, write it in PRODUCT.md, and mention it in your reply.
- An architecture question → `docs/ARCHITECTURE.md` and DECISIONS.md; if open, write a *Proposed* ADR with options and your recommendation, and ask before building on it if it's expensive to reverse.
- A security question → SECURITY.md; when in doubt, take the more restrictive option and record it.
- Something only Dwahnil knows (a firm's setup, pricing, a vendor account) → ask in one short question, and park the task in PROGRESS.md meanwhile.
