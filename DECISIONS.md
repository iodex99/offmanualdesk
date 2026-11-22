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
