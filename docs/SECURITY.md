# Security

## 1. Assets

Client financial data (books, statements, returns, notices), client identifiers (PAN, Aadhaar, GSTIN, bank details), firm credentials (portal logins, DSC), employees' mail and Telegram accounts, LLM keys, Off Manual's release-signing keys.

## 2. Threats and controls

| Threat | Control |
| --- | --- |
| Malicious or compromised skill | No ClawHub at runtime; vendored, read, scanned, pinned by SHA-256, signed into release (SKILLS.md §2) |
| Employee reads another employee's work | Gateway per employee as their Windows account; unique port + token; Desk-only token holder |
| Another session connects to my gateway on loopback | Token auth on every gateway; token DPAPI CurrentUser; port leases tracked by Server Agent |
| Spoofed identity over the pipe | Identity from OS client token only; ACL on pipe |
| Agent works around Access Denied | Guard stops the turn on access errors; no alternate path, no copy; audit |
| Prompt injection from a document or email makes the agent act | Review queue for irreversible/external actions; skill packs limit tools (guard allowlist from the signed `packs.json`, fail closed; ADR-043); Telegram text-only; no portal submission |
| Client data leaks through a problem report | Bundle is metadata only and shown in full before sending; strict console schema rejects any other field; free text limited to 500 characters with a warning; no screenshots in v1 (ADR-050) |
| Client data leaks to Off Manual | Console receives counts/versions/health only; audit summaries without paths |
| Client data leaks via Telegram | Text-only default; files only if firm enables; Server Agent enforces (incoming files refused without downloading; replies are plain text, no parse mode) |
| Server Agent holds every employee's gateway token (relay) | It runs as SYSTEM, which already controls the host; tokens are DPAPI machine-scope in the SYSTEM/Admins-only agent.db, used only to relay a linked employee's own Telegram messages to their own gateway (ADR-040) |
| Stolen employee password | OAuth bound to SID + TOTP; daily code; lockouts |
| Admin resets someone's authenticator to take over | Reset only clears the authenticator; re-enrolment still happens in the employee's own Windows session (OS-derived SID), and the reset is firm-scoped, audited by the policy version, applied once per request (ADR-049) |
| Lost phone / recovery code abuse | 8 single-use codes (~49 bits each), only salted hashes stored, usable only from the employee's own Windows session, 5 tries/hour, audit event; using one resets the authenticator and revokes the day grant (ADR-046) |
| Someone binds another person's Off Manual account to their own Windows account | The bind code is shown only after the employee's own OIDC sign-in and is typed into Desk, which sends the SID from the OS; a SID pre-filled by AD import must match; one SID per employee per firm; same OIDC subject once bound; code single use, 10 min, hashed; 10 tries/hour per SID (ADR-044) |
| Stolen console/firm-admin Google or Microsoft account | Console requires TOTP after OIDC (no bypass; pre-MFA sessions can do nothing and expire in 10 min); codes single-use; session tokens stored hashed; disabling a user ends sessions at once (ADR-037) |
| Firm admin reads another firm's data | Every firm-scoped handler calls `requireFirmAccess(session, firmIdFromUrl)`; an admin email listed for two firms can't sign in (ambiguous) |
| Shoulder access to unlocked desk | Idle lock, PIN, step-up for sensitive actions |
| Tampered update | Authenticode on binaries + ed25519-signed manifest with SHA-256 of payload; agent verifies both before staging |
| Stolen release key | Key only in GitHub Actions secrets / HSM-backed signing; rotation procedure; manifest carries key ID |
| Lost LLM key | Firm-owned key DPAPI machine scope; rotate via console |
| Tally posting errors | Read-only default; review queue; read-back check |
| Departed employee | Console disable → gateway stop, Telegram unlink, token revoke |
| Another user squats the Server Agent pipe (creates an instance and reads PINs/codes). Verified in CI: a standard GENERIC_WRITE client is refused even as Administrator; clients use read + write-data only (ADR-034) | Pipe DACL gives users `FILE_GENERIC_READ \| FILE_WRITE_DATA` only (no `FILE_CREATE_PIPE_INSTANCE`), `FILE_FLAG_FIRST_PIPE_INSTANCE`, `PIPE_REJECT_REMOTE_CLIENTS`; clients verify the server process is LocalSystem (ADR-029; L7) |
| Brute-forcing a gateway token from another RDS session (all sessions are "loopback") | 256-bit tokens; `gateway.auth.rateLimit.exemptLoopback: false` (OpenClaw's default exempts loopback); device-auth handshake (ADR-021; L2 measures it) |
| Gateway opens extra listeners (browser control/CDP, MCP Apps) other sessions can reach | `browser` plugin denied, MCP Apps off, Desk refuses to run a gateway whose process tree listens on anything but its leased port (ADR-020; L1) |
| Agent installs a skill/plugin or edits its own config | Layered lockdown: `OPENCLAW_CONFIG_READONLY=1`, guard `before_install` block, `security.installPolicy`, tool denies, skill roots wiped before start (ADR-024) |
| Employee tampers with their own gateway (it runs as them) | Out of scope for the guard; config read-only to the user, Server Agent checks plugin inventory, LLM key proxy considered (ADR-027). Windows rights still bound what files they reach |
| Agent keeps going after Access Denied | Tool-result middleware rewrites the denial, every later tool call in the run is blocked, Desk aborts the run (ADR-022; L3) |
| Machine-scope DPAPI secret read by any local user who copies the blob (implemented: `C:\ProgramData\OffManual` is SYSTEM + Administrators only, set by `server-agent install`; ADR-033) | LocalMachine DPAPI is decryptable by any local account with the blob (+ entropy): machine secrets also need SYSTEM-only file ACLs (L10) |

## 3. Unbreakable rules

See BUILD_PROMPT.md §3. Any code that would violate one needs an ADR and Dwahnil's explicit approval first.

## 4. Logging

- Log: timestamps, correlation IDs, SIDs (hashed in anything sent to console), event types, durations, error codes, versions.
- Never log: prompts, model output, file contents, file names in console-bound data, PAN/Aadhaar/GSTIN, tokens, secrets.
- Local audit log (on firm server) may contain paths; it is visible only to the firm admin.

## 5. Data protection

- Firm signs a data-processing note: what goes to the LLM provider, Telegram policy, retention.
- LLM provider: API terms that exclude training on customer data; record provider and terms version in the firm's contract.
- Retention: archived agent state per firm setting (default 180 days), then deleted.
- PAN/Aadhaar masking (`india-id-check`) in anything shared outside the firm's server.

## 6. Review checklist (M11)

- [ ] Pipe ACL and SID derivation tested with a second user trying to call as the first
- [ ] Gateway token isolation tested across two RDS sessions
- [ ] Access-denied path tested on UNC, mapped drive, OneDrive folder
- [ ] Review queue cannot be bypassed by any skill in the pack (v1: deletes only exist as `offmanual_delete_files`; exec/apply_patch delete patterns are blocked as defence in depth, ADR-041; re-check when each pack adds tools)
- [ ] Telegram text-only blocks attachments, links to files and base64 dumps
- [ ] Console payloads inspected: no client content
- [ ] Update with bad signature / bad hash refused
- [ ] Offboarding leaves no running process, token or Telegram link
- [ ] Secrets scan on repo history
