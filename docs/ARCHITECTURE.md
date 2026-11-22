# Architecture

Status markers: **[V]** verified in lab or source, **[A]** assumption pending `LAB_VALIDATION.md` item. Update markers as results come in.

## 1. Components

| Component | Runs as | Where | Responsibilities |
| --- | --- | --- | --- |
| Console | Vercel | Cloud | Superadmin/staff/firm admin UI; agent API; billing; releases; notifications |
| Release store | Object storage (R2/S3) | Cloud | Signed release zips + manifests |
| Server Agent | Windows service, LocalSystem | Firm RDS host | Enrolment + heartbeat; policy; TOTP/PIN verification; lock state; gateway port/token leases; Telegram router; audit log; usage counts; update staging; pre-flight; support bundles |
| Desk | Each employee | Their RDS session, started at logon | Sign-in, unlock, lock, chat panel, tasks, review queue, client directory, notices; starts/stops their gateway |
| OpenClaw gateway | Each employee's Windows account | Their session (child of Desk) or per-user Scheduled Task when logged off [A L5] | The agent |
| guard plugin | Inside each gateway | — | Enforce lock, licence, skill packs, review queue, Telegram policy, access-denied handling, audit events |
| channel-relay plugin | Inside each gateway | — | Telegram in/out through Server Agent pipe |
| File server | Firm | Firm LAN | NTFS/share rights decide access |
| TallyPrime | Each employee (multi-user) | RDS host | XML-over-HTTP port per session [A L4] |
| LLM provider | — | Cloud | Model calls with the firm's key by default |
| Telegram | — | Cloud | One firm bot |

## 2. Processes and trust

- Trust boundary per employee = their Windows account + their gateway (ADR-001).
- Server Agent is the only process that talks to Off Manual's cloud. It never receives prompts or file contents.
- Desk holds the gateway token; the token is DPAPI-encrypted (CurrentUser scope) at rest.
- Gateway listens on `127.0.0.1:<leased port>` with token auth always on. All RDS sessions share loopback, so the token is the isolation [A L2].

## 3. Inter-process communication

### 3.1 Named pipe: Desk / plugins ↔ Server Agent

- Pipe: `\\.\pipe\offmanual-agent`. ACL: SYSTEM full; Authenticated Users read/write (connect only). No anonymous.
- Protocol: JSON-RPC 2.0, one JSON object per line (newline-delimited), UTF-8.
- Caller identity: the agent calls `GetNamedPipeClientProcessId` / impersonates the client to read its token → SID and session ID. Every method authorises on that SID. Message bodies never carry identity.
- Methods (v1; schemas in `packages/shared-schema/ipc/`):

| Method | Caller | Purpose |
| --- | --- | --- |
| `session.hello` | Desk | Register session, get employee record, policy hash, licence state |
| `auth.bindStart` / `auth.bindComplete` | Desk | First-run binding of OAuth account to SID (via console) |
| `auth.totpEnrolStart` / `auth.totpEnrolConfirm` | Desk | TOTP enrolment |
| `auth.pinSet` | Desk | Set/reset PIN (requires TOTP) |
| `auth.verifyDaily` | Desk | TOTP → day unlock |
| `auth.verifyPin` | Desk | PIN → idle unlock |
| `auth.stepUp` | Desk | TOTP for sensitive action; returns short-lived step-up grant |
| `lock.get` / `lock.set` | Desk, guard | Lock state per SID |
| `gateway.lease` / `gateway.release` | Desk | Port + token lease, start/stop record |
| `policy.get` | Desk, guard | Effective policy for this SID (packs, Telegram mode, lock limits) |
| `audit.append` | guard | Append audit event |
| `review.notify` | guard | Count of pending items (for Telegram/Desk badges) |
| `telegram.linkStart` | Desk | One-time deep-link code |
| `telegram.subscribe` | channel-relay | Stream inbound messages for this SID |
| `telegram.send` | channel-relay | Outbound message (policy-checked) |
| `access.request` | Desk | Request access note to admin |
| `notices.list` / `notices.ack` | Desk | Update, billing, admin notices |
| `update.status` / `update.switch` | Desk | Staged version, restart-to-update |
| `support.bundle` | Desk | Build support bundle (metadata only) |

### 3.2 Desk ↔ gateway

OpenClaw's gateway WebSocket/HTTP API on loopback with token (verify exact protocol in OPENCLAW_NOTES.md §3). Desk is the only UI client; the OpenClaw Control UI is disabled or bound behind the same token.

### 3.3 Server Agent ↔ console

HTTPS, signed requests (ADR-013). Endpoints in `apps/console/app/api/agent/*`:

| Endpoint | Purpose |
| --- | --- |
| `POST /enroll` | One-time enrolment code + public key → server ID |
| `POST /heartbeat` | Every 15 min: versions, health, active seats, counts, licence state request |
| `GET /policy` | Firm policy + employees + packs (ETag) |
| `GET /releases` | Assigned release for this server (ring/pin) |
| `POST /usage` | Daily token counts per employee |
| `POST /audit-summary` | Counts by category; no paths or contents |
| `POST /support` | Support bundle upload |
| `GET /notices` | Billing/admin notices for this firm |
| `POST /auth/bind` | Complete OAuth → SID binding |
| `GET /auth/secrets` | Encrypted TOTP secrets sync (encrypted to server's key) |

Long-lived connection for push (release available, policy changed): Server-Sent Events from `GET /stream`, with 15-minute polling as fallback.

## 4. Ports

| Use | Range | Notes |
| --- | --- | --- |
| Gateways | 18800–19799 | Leased per SID by Server Agent; stable per employee where possible |
| Tally XML per session | 19800–19899 | [A L4] how to configure per-session port |
| Server Agent | none | Pipe only |

## 5. Paths

```
C:\Program Files\OffManual\
  current\              junction → versions\<semver>
  versions\<semver>\
    server-agent.exe
    desk\               Tauri app
    node\               pinned Node runtime
    openclaw\           pinned OpenClaw
    plugins\guard\  plugins\channel-relay\
    skills\             signed skill pack
    manifest.json       signed release manifest
C:\ProgramData\OffManual\
  policy.json           read-only for users
  agent.db              SQLite (DATA_MODEL.md §2)
  staging\  logs\  backups\  support\
%LOCALAPPDATA%\OffManual\      (or FSLogix profile)
  openclaw-state\       gateway state dir (sessions, memory, review queue)
  desk\                 settings, DPAPI-protected gateway token
```

## 6. Flows

### F1 Firm install
1. Off Manual creates firm + server in console → enrolment code (single use, 24 h).
2. Run MSI on the RDS host (admin) → installs `versions\<v>`, `current`, Server Agent service, Desk autostart (HKLM Run or All Users Startup), WebView2 bootstrapper.
3. Server Agent starts → asks for enrolment code (MSI property or `server-agent.exe enroll <code>`) → generates ed25519 keypair → `POST /enroll`.
4. Pre-flight runs and reports: Windows version, RAM/CPU, free disk, RDS role, WebView2, Node runs, file server reachable via UNC, TallyPrime present + version, outbound HTTPS to console/LLM/Telegram, time sync.
5. Setup wizard (console) shows pre-flight results; admin imports users from an AD group or adds them by hand; invites go out.

### F2 Employee first run
1. Desk starts at logon, `session.hello` → unknown SID → "Sign in to get started".
2. Desk opens system browser → console OAuth (Google/Microsoft) → console matches invite email → returns binding code.
3. Desk `auth.bindComplete(code)` → Server Agent confirms caller SID equals the SID on the invite → console marks bound. Mismatch → refused with plain message.
4. TOTP enrolment (QR + confirm) → recovery codes shown once → PIN set.
5. Optional Telegram link (F7). First-run tour shows 3 task buttons for their role.

### F3 Daily unlock, idle lock, step-up
- First Desk unlock of the working day → `auth.verifyDaily` → day grant until firm's day end.
- Idle ≥ lock timeout → `lock.set(locked)`; guard rejects inbound turns from all channels; running scheduled jobs finish.
- PIN → `auth.verifyPin`; 3 wrong PINs → daily code needed; 5 wrong codes → 15 min lockout + admin alert.
- Sensitive action (firm list) → `auth.stepUp` → grant valid 10 minutes for that action class.

### F4 Gateway lifecycle
1. On unlock (or task start), Desk `gateway.lease` → `{port, token, stateDir, versionPath}`.
2. Desk writes gateway config (port, token auth, plugins, skills path, policy path, Telegram channel disabled, ClawHub/skill install disabled) into the user's state dir.
3. Desk starts `node\…\openclaw gateway` from `current\` as a child process (inherits the user's token) [A L1].
4. Health check → connect WebSocket → ready.
5. Idle N hours (firm setting) → Desk stops the gateway; next message starts it again.
6. Logged-off employees: per-user Scheduled Task started by Server Agent on Telegram message [A L5, L6].

### F5 Chat turn and access denied
1. Desk sends message → gateway → guard `before turn`: lock state (cached ≤ 5 s), licence, channel policy.
2. Agent runs tools. Tool `before call`: guard checks the skill pack allows it; review-listed actions are converted into a proposal (F6).
3. A file tool gets `EACCES` / Windows error 5 → guard `after call` converts to `access_denied{path}` → turn stops (no alternate path, no copy) → Desk shows the plain message + *Request access* → `audit.append`.
   Exact hook names: OPENCLAW_NOTES.md §5.

### F6 Review queue
1. Guard intercepts a listed action (Tally voucher create/alter/cancel, client email, delete, portal action) → stores a proposal (action, params, human summary, before/after) in the user's state → returns "queued for review" to the agent.
2. Desk *Review* tab: list, approve all, edit, reject. Step-up if the firm requires.
3. Approve → guard executes → for Tally, re-fetches the voucher and compares → result + audit.

### F7 Telegram linking and messages
1. Desk `telegram.linkStart` → code (single use, 10 min) → opens `https://t.me/<FirmBot>?start=<code>`.
2. Employee presses Start → Server Agent (polling `getUpdates`) sees `/start <code>` → binds Telegram user ID ↔ SID → confirms in chat.
3. Inbound message from a linked user → policy check → if gateway down, start it [A L6] → deliver via `telegram.subscribe` stream → channel-relay plugin → agent.
4. Outbound → channel-relay `telegram.send` → Server Agent enforces Telegram mode (no files in text-only) → Bot API.
5. Unlinked senders get one "not linked" reply; nothing else.

### F8 Unlock from Telegram
- Desk "Approve on Telegram" → bot sends inline Approve/Deny → callback → `lock.set(unlocked)` for Desk.
- Away: `/unlock 123456` → TOTP check → Telegram-only unlock for the firm's window.

### F9 Update
See UPDATES.md. Server Agent stages; Desk shows notice; employee restarts; gateway restarts from new `versions\<v>`.

### F10 Offboarding
Console disable → policy push → Server Agent stops gateway (signals Desk / kills process tree for that SID), wipes Telegram link, revokes tokens, archives `openclaw-state` to `backups\` for the firm's retention period, frees port lease.

### F11 Report a problem
Desk → `support.bundle` → versions, health, last 200 log lines (metadata only), policy hash, pre-flight → preview shown to employee → optional screenshot (employee crops) → upload → console ticket.

## 7. Repository layout

```
offmanual-desk/
  CLAUDE.md  BUILD_PROMPT.md  PROGRESS.md  DECISIONS.md  CHANGELOG.md
  docs/
  .claude/  settings.json  hooks/  skills/  rules/
  apps/
    server-agent/   cmd/server-agent, internal/{pipe,auth,policy,lease,telegram,update,audit,store,console,preflight}
    desk/           src-tauri/ (Rust), ui/ (React + TS)
    console/        app/, app/api/agent/*, db/ (Drizzle schema + migrations), lib/
  packages/
    shared-schema/  ipc/*.json, policy.schema.json, manifest.schema.json, codegen → TS + Go
    openclaw-plugins/guard/   openclaw-plugins/channel-relay/
  skills/
    vendored/<owner>__<slug>/   offmanual/<skill>/   registry.lock.json
  installer/        WiX v4
  lab/              L1…L10 scripts, results/
  tools/            skill-vet/, release/, sign-manifest/
  .github/workflows/  ci.yml  release.yml
```
