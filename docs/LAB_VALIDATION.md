# Lab validation

Assumptions that must hold on a real Windows Server 2022 RDS host before we build on them. Claude Code writes the scripts in `lab/`; Dwahnil runs them and pastes the output; `/lab-result` records it here and updates affected ADRs and ARCHITECTURE.md markers.

Lab (setup steps in `lab/README.md`): Windows Server 2022, RDS Session Host, 3 users (`labA`, `labB`, `labAdmin`), file share `\\lab-fs\Clients` with folder `ClientX` readable by `labA` only and `ClientY` readable by both, TallyPrime (educational mode), outbound internet.

| ID | Question | Pass when | Affects | Script | Status | Result |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | Does a native Windows OpenClaw 2026.11.6 gateway run per user under RDS from a read-only install? RAM per idle/busy gateway? 5 at once? Which ports does each gateway listen on? Does a plugin load from `plugins.load.paths`? | Gateways for labA and labB run concurrently from one read-only install (record whether `OPENCLAW_ALLOW_MULTI_GATEWAY` is needed); RAM recorded; **only the leased base port listens** (`single_port_only`); probe plugin loads and its `openclaw/plugin-sdk/*` import resolves | ADR-001, ADR-003, ADR-019, ADR-020, ADR-024 | `lab/L1-gateway-per-user.ps1` | Script ready | |
| L2 | Is loopback isolation by token real? Is failed auth rate-limited across sessions? | labB can't use labA's gateway over HTTP, WS or CLI without the token; wrong tokens get 429 with `exemptLoopback:false`; record whether labB's flood locks out labA's correct token (all sessions are 127.0.0.1); unauthenticated routes leak nothing beyond readiness | ADR-001, ADR-021, SECURITY | `lab/L2-loopback-token-isolation.ps1` | Script ready | |
| L3 | How does Access Denied surface to tools (UNC, mapped drive, redirected folder, child process)? | For each path type: Node `err.code`/errno (expect `EPERM`/-4048), .NET HResult, cmd/PowerShell text recorded; guard classifier matches every case; mapped drive visibility in child/scheduled processes recorded | F5, ADR-022, guard | `lab/L3-access-denied.ps1` | Script ready (smoke-tested on Windows 11 local folder: Node EPERM -4048; cmd "Access is denied."; .NET 0x80070005) | |
| L4 | Can each session's TallyPrime use its own XML port? Does company security affect XML? | Two sessions answer on different ports (note: port lives in the install-folder `tally.ini`, shared by all sessions); behaviour with security on recorded; cross-session reachability recorded | ADR-012 | `lab/L4-tally-xml-port.ps1` | Script ready | |
| L5 | Can a gateway run as a per-user Scheduled Task while the user is logged off, with UNC access? | UNC read of `ClientX` as labA recorded for **S4U vs Password** logon; DPAPI CurrentUser decrypt inside the task recorded (run L10 Protect first) | F4, ADR-005, ADR-026 | `lab/L5-scheduled-task-logged-off.ps1` + `lab/task-runner.ps1` | Script ready | |
| L6 | Can the SYSTEM service start that task on demand, and how fast to ready? | Task started from SYSTEM; seconds from trigger to `/readyz` recorded | ADR-005, ADR-023, ADR-026 | `lab/L6-system-starts-task.ps1` | Script ready | |
| L7 | Does the pipe server get the right SID for a non-admin caller? Can labB impersonate or squat? | Process-token SID correct for labA and labB at every impersonation level; body SID claims ignored; with the ADR-029 DACL a non-admin can't create a pipe instance | SECURITY, ADR-029 | `lab/L7-pipe-caller-sid.ps1` | Script ready (self-test on Windows 11 passed; generic-write DACL allowed squatting, strict DACL refused with error 5) | |
| L8 | Desk autostart per session, single instance per session (ADR-059), global hotkey Ctrl+Alt+O over RDP (ADR-064), Explorer context menu per user | All work for labA and labB at once | Desk | `lab/L8-desk-session-behaviour.ps1` | Script ready (mutex, hotkey, path forwarding smoke-tested) | |
| L9 | WebView2 runtime on Server 2022 RDS; RAM per Desk instance | Runtime present/installable, version recorded; RAM per Desk re-measured once Desk exists | ADR-007 | `lab/L9-webview2.ps1` | Script ready (PARTIAL by design until Desk is built) | |
| L10 | DPAPI CurrentUser survives logoff/logon (local and FSLogix profiles); machine scope readable by service only | Token decrypts after re-logon; labB can't decrypt labA's blob; LocalMachine-scope behaviour recorded (expect: any local user with blob + entropy can decrypt, so machine secrets need SYSTEM-only ACLs) | ARCHITECTURE §2, SECURITY | `lab/L10-dpapi.ps1` | Script ready | |
| L11 | Offboarding on the RDS host (during the pilot install) | After switching off labB in the console: labB's gateway process is gone within a minute; after 15 more minutes `C:\ProgramData\OffManual\backups\offboarded\<SID>-*.zip` exists and labB's `%LOCALAPPDATA%\OffManual\openclaw-state` is gone; record whether `%LOCALAPPDATA%` is `<profile>\AppData\Local` and what happens with FSLogix (profile only mounted while signed in) | F10, ADR-056 | Manual (install runbook) | Not run | |

Run order and who runs what: `lab/README.md`. Run L10 `-Phase Protect` before L5. L1 `-Role Install` (labAdmin) before L1/L2/L5/L6.

## Results log

<!-- /lab-result appends here, newest first:
### L? — YYYY-MM-DD — PASS/FAIL/PARTIAL
- Environment: …
- Output summary: …
- Conclusion: …
- Changed: ADR-…, ARCHITECTURE.md …
-->
