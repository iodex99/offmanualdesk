# Off Manual Desk: project memory for Claude Code

Managed AI assistant for Indian CA firms, built on OpenClaw, installed on the firm's Windows RDS server. One OpenClaw gateway per employee, running as that employee's Windows account, so the firm's existing NTFS rights decide file access. Sold by Off Manual (Dwahnil, solo founder, Mumbai) as setup + per seat + AMC.

## Current state

@PROGRESS.md

## Where everything is

| Need | Read |
| --- | --- |
| Who uses it, ease rules, v1/v2 features | `docs/PRODUCT.md` |
| Components, IPC, ports, flows, repo layout | `docs/ARCHITECTURE.md` |
| Threat model, unbreakable rules | `docs/SECURITY.md` |
| Console DB + Server Agent local store | `docs/DATA_MODEL.md` |
| Contracts, invoices, GST, enforcement ladder | `docs/BILLING.md` |
| Release pipeline, rings, staging, rollback | `docs/UPDATES.md` |
| Skill registry, starter pack, India pack, task buttons | `docs/SKILLS.md` |
| Unproven assumptions + lab results | `docs/LAB_VALIDATION.md` |
| Verified OpenClaw API facts (pinned version) | `docs/OPENCLAW_NOTES.md` |
| Why things are the way they are | `DECISIONS.md` |
| What shipped | `CHANGELOG.md` |
| The original build brief | `BUILD_PROMPT.md` |

Read only the docs the current task touches. Never answer from memory of an earlier session; read the file.

## Repo map

```
apps/server-agent      Go Windows service (LocalSystem): licence, updates, policy, auth checks, lock, ports, Telegram router, audit
apps/desk              Tauri 2 + React/TS: per-employee app, sign-in, lock, chat panel, tasks, review queue
apps/console           Next.js + Postgres (Drizzle) on Vercel: superadmin, firm admin, billing, releases, agent API
packages/openclaw-plugins/guard          lock, licence, skill packs, approvals, access denied, audit
packages/openclaw-plugins/channel-relay  Telegram via Server Agent
packages/shared-schema  JSON Schemas + generated TS/Go types (policy, IPC, release manifest)
skills/                 private registry: vendored/ (pinned copies), offmanual/ (own), registry.lock.json
installer/              WiX v4 MSI (first install only)
lab/                    PowerShell validation spikes + results
tools/                  skill vetting, release, manifest signing
```

## Commands

Fill these in during M0 and keep them correct. Placeholder until then:

- Install: `TBD`
- Lint all: `TBD`
- Test all: `TBD`
- Console dev: `TBD`
- Desk dev: `TBD`
- Server Agent build/test: `TBD`

## Non-negotiable rules (full list in BUILD_PROMPT.md §3 and docs/SECURITY.md)

1. One gateway per employee, as that employee's Windows account. Never shared.
2. No own file-permission layer; Windows rights only. Never work around Access Denied.
3. Loopback + unique port + unique token for every gateway.
4. Server Agent takes caller identity from the OS (pipe client token → SID), never from message bodies.
5. No ClawHub at runtime. Skills only from `skills/`, pinned by hash, reviewed, signed.
6. Irreversible/external actions go through the review queue. Portal OTP/DSC stay human.
7. Tally read-only unless in a Tally-post pack; own session's Tally only; read back after posting.
8. Telegram text-only by default.
9. TOTP mandatory for everyone.
10. No client data (prompts, file contents, file names) leaves the firm's server for Off Manual's cloud.

## Never guess an API

Verify OpenClaw, Tally XML, Telegram Bot API, Windows APIs and Razorpay against docs **and** source before coding; record OpenClaw findings in `docs/OPENCLAW_NOTES.md` with URL/path and version.

## Memory protocol: after EVERY code or config change, before ending the turn

1. `PROGRESS.md`: checklist, Current focus, Next step, dated Session log entry (newest first).
2. `CHANGELOG.md`: line under Unreleased.
3. `DECISIONS.md`: new ADR for any choice between options (`/adr`); supersede, never delete.
4. Affected `docs/*.md`: describe the system as it now is.
5. `docs/OPENCLAW_NOTES.md` for anything verified about OpenClaw.

`/checkpoint` does all five. A Stop hook blocks ending a turn when code changed after PROGRESS.md. `/pickup` reloads state at session start. `/lab-result` records a pasted lab run.

## Style

- TypeScript strict; Go with `golangci-lint`; Rust with `clippy -D warnings`.
- Plain-language UI text (see PRODUCT.md ease rules). Indian English, ₹, DD-MM-YYYY dates in UI, FY as "FY2025-26".
- Conventional commits, one logical change each.
- Logs: metadata only, correlation IDs, no client content.
