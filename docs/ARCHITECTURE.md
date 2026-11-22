# Architecture

Status markers: **[V]** verified in lab or source, **[A]** assumption pending `LAB_VALIDATION.md` item. Update markers as results come in.

## 1. Components

| Component | Runs as | Where | Responsibilities |
| --- | --- | --- | --- |
| Console | Vercel | Cloud | Superadmin/staff/firm admin UI; agent API; billing; releases; notifications |
| Release store | Object storage (R2/S3) | Cloud | Signed release zips + manifests |
| Server Agent | Windows service, LocalSystem | Firm RDS host | Enrolment + heartbeat; policy; TOTP/PIN verification; lock state; gateway port/token leases; Telegram router; audit log; usage counts; update staging; pre-flight; support bundles |
| Desk | Each employee | Their RDS session, started at logon | Sign-in, unlock, lock, chat panel, tasks, review queue, client directory, notices; starts/stops their gateway |
| OpenClaw gateway | Each employee's Windows account | Their session (child of Desk, in a Job Object) [V docs, A L1]; logged-off gateways out of v1 (ADR-026, Proposed) | The agent |
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
- Gateway listens on `127.0.0.1:<leased port>` (`gateway.bind: "loopback"`) with token auth always on (`gateway.auth.mode: "token"`). All RDS sessions share loopback, so the token (plus OpenClaw's device-auth handshake) is the isolation, and the failed-auth limiter must cover loopback (`gateway.auth.rateLimit.exemptLoopback: false`; the default is true) [A L2; ADR-021].
- The guard protects against the agent, not against the employee: the gateway runs as the employee, who could edit their own gateway (ADR-027, Proposed).

## 3. Inter-process communication

### 3.1 Named pipe: Desk / plugins ↔ Server Agent

- Pipe: `\\.\pipe\offmanual-agent`. ACL (ADR-029): SYSTEM full; Authenticated Users `FILE_GENERIC_READ | FILE_WRITE_DATA` only (generic write would include `FILE_CREATE_PIPE_INSTANCE` and let any user squat the pipe: shown by lab L7 self-test); created with `FILE_FLAG_FIRST_PIPE_INSTANCE` and `PIPE_REJECT_REMOTE_CLIENTS`. No anonymous. Clients verify the server end is a LocalSystem process (`GetNamedPipeServerProcessId` → token SID S-1-5-18) before sending anything.
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

Verified (OPENCLAW_NOTES.md §3): WebSocket at `ws://127.0.0.1:<port>`, JSON frames `req`/`res`/`event`, protocol v4. The server sends `connect.challenge {nonce, ts}`; the client sends `connect` with `client {id (closed enum), version, platform, mode}`, `role: "operator"`, scopes, `auth {token}` and an Ed25519 `device` signature over the challenge; the server answers `hello-ok`. Chat: `chat.send {sessionKey, message, idempotencyKey}` → streamed `chat` events (`delta`, `final` with `usage`, `aborted`, `error`); stop with `chat.abort {sessionKey, runId}`. Unauthenticated HTTP probes: `/healthz`, `/readyz`.

Proposed (ADR-021): Desk implements this client in Rust (no browser `Origin`, which the gateway origin-checks), with a per-user DPAPI-protected device key. Control UI and operator terminal are disabled (`gateway.controlUi.enabled: false`, `gateway.terminal.enabled: false`; the terminal defaults to on). Desk is the only UI client.

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
| Gateways | 18800–19799 | Leased per SID by Server Agent; stable per employee where possible. A gateway also binds base+1/+2/+9…+110 unless MCP Apps and the `browser` plugin are off (ADR-020, Proposed; L1 records every listener) |
| Tally XML per session | 19800–19899 | [A L4] how to configure per-session port. Tally's port lives in the install-folder `tally.ini`, shared by all sessions; L4 records whether per-session ports are possible at all |
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
    plugins\guard\      openclaw.plugin.json, package.json, dist\ (channel-relay not shipped while ADR-023 is open)
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
2. Desk writes the gateway config (JSON5 `openclaw.json`: `gateway {mode: "local", port, bind: "loopback", auth {mode: "token", rateLimit {exemptLoopback: false}}, controlUi and terminal disabled}`, `plugins {load.paths, entries, deny: [telegram, browser, device-pair]}`, skills lockdown per ADR-024, updates and telemetry off). Proposed (ADR-027): the config lives where the user can't edit it and `OPENCLAW_CONFIG_READONLY=1` is set.
3. Desk sets `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_NO_RESPAWN=1`, `OPENCLAW_NO_AUTO_UPDATE=1`, `OPENCLAW_DISABLE_BONJOUR=1`, `OPENCLAW_EXEC_SHELL_SNAPSHOT=0`, `DO_NOT_TRACK=1`, `CLAWHUB_DISABLE_TELEMETRY=1` and a controlled CWD, then starts `current\node\node.exe current\openclaw\node_modules\openclaw\openclaw.mjs gateway run --port <p> --bind loopback --auth token` as a child process (inherits the user's token) inside a Job Object with KILL_ON_JOB_CLOSE, because the gateway does not follow its parent's lifetime [V docs `gateway/embedding`; A L1]. Exit code 78 → `openclaw doctor --fix --yes --non-interactive`, retry once.
4. Wait for `connect.challenge` → `hello-ok` (a `connect` during startup returns a retryable `UNAVAILABLE`); check the process tree listens only on the leased port (ADR-020) → ready.
5. Idle N hours (firm setting) → Desk stops the gateway; next message starts it again.
6. Logged-off employees: the original plan was a per-user Scheduled Task started by the Server Agent. OpenClaw's own task uses S4U, which has no network credentials, so it can't read the file server. Proposed (ADR-026): no logged-off gateways in v1 [L5, L6].

### F5 Chat turn and access denied
1. Desk sends `chat.send` → gateway → guard `before_agent_run`: lock state (cached ≤ 5 s), licence, channel policy. It returns `{outcome: "block", reason, message}` to refuse; a thrown error or the 15 s timeout also blocks (fail-closed) [V source].
2. Agent runs tools. Guard `before_tool_call` checks the skill pack allows the call; review-listed actions are blocked with "Queued for review #id" and stored as a proposal (F6, ADR-028).
3. Access denied (Proposed, ADR-022; the original "after-call hook stops the turn" is impossible: `after_tool_call` is observe-only and plugins can't abort a run). Node on Windows reports a denial as `EPERM` (Win32 error 5; confirmed by the L3 smoke test on Windows 11), `exec` as output text ("Access is denied."). The guard's tool-result middleware rewrites any denial result to a fixed ACCESS_DENIED text before the model sees it and marks the run; `before_tool_call` then blocks every further tool call in that run (no alternate path, no copy); the guard tells Desk over the pipe; Desk sends `chat.abort` and shows the plain message + *Request access* → `audit.append` [A L3 on UNC/mapped drives].

### F6 Review queue
1. Guard intercepts a listed action in `before_tool_call` (Tally voucher create/alter/cancel, client email, delete, portal action) → stores a proposal (action, params, human summary, before/after) in the user's state → blocks the call with `blockReason` "Queued for review #<id>" (a hook can't return a synthetic success; ADR-028, Proposed).
2. Desk *Review* tab: list, approve all, edit, reject. Step-up if the firm requires.
3. Approve → guard executes → for Tally, re-fetches the voucher and compares → result + audit.

### F7 Telegram linking and messages
1. Desk `telegram.linkStart` → code (single use, 10 min) → opens `https://t.me/<FirmBot>?start=<code>`.
2. Employee presses Start → Server Agent (polling `getUpdates`) sees `/start <code>` → binds Telegram user ID ↔ SID → confirms in chat.
3. Inbound message from a linked user → policy check → the gateway must be running (employee logged in; ADR-026). Original plan: deliver via the `telegram.subscribe` stream → channel-relay plugin → agent. Proposed (ADR-023): the Server Agent connects to the employee's gateway as a client and sends `chat.send` on a dedicated Telegram session key; no channel plugin in v1.
4. Outbound → (ADR-023) the Server Agent takes the `chat` final event text → enforces Telegram mode (no files in text-only) → Bot API. (Original plan: channel-relay `telegram.send`.)
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
  CLAUDE.md  BUILD_PROMPT.md  PROGRESS.md  DECISIONS.md  CHANGELOG.md  README.md
  package.json  pnpm-workspace.yaml  tsconfig.base.json  eslint.config.mjs  .prettierrc.json  .nvmrc
  go.work  .golangci.yml  release.config.json
  docs/
  .claude/  settings.json  hooks/ (+ hooks/test/)  skills/  rules/
  apps/
    server-agent/   Go module offmanual/desk/server-agent
                    cmd/server-agent (M0: version/help), internal/version,
                    pkg/manifest (release manifest sign/verify/extract; keys/*.pub),
                    internal/{pipe,auth,policy,lease,telegram,update,audit,store,console,preflight} (created in M2+)
    desk/           ui/ (React + TS, Vite root) → dist/, src-tauri/ (Rust, Tauri 2), app-icon.png
    console/        app/, app/api/health, app/api/agent/* (M3), db/ (Drizzle, M3), lib/, test/
  packages/
    shared-schema/  schemas/{manifest,manifest-signature}.schema.json, schemas/ipc/envelope.schema.json,
                    src/index.ts (validators, pipe method list), src/format.ts (₹, DD-MM-YYYY, FY), fixtures/
    openclaw-plugins/guard/   openclaw-plugins/channel-relay/
  skills/
    vendored/<owner>__<slug>/   offmanual/<skill>/   registry.lock.json
  release/
    openclaw/       package.json + package-lock.json pinning OpenClaw for the payload
  installer/        WiX v4 (M8)
  lab/              common.ps1, L1…L10 scripts, README.md runbook, results/
  tools/            release/ (prepare, check-tag, notes, verify-skills), sign-manifest/ (Go), skill-vet/ (M7)
  .github/          workflows/ci.yml  workflows/release.yml  dependabot.yml
```
