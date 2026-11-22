# Lab validation

Assumptions that must hold on a real Windows Server 2022 RDS host before we build on them. Claude Code writes the scripts in `lab/`; Dwahnil runs them and pastes the output; `/lab-result` records it here and updates affected ADRs and ARCHITECTURE.md markers.

Lab: Windows Server 2022, RDS Session Host, 3 users (`labA`, `labB`, `labAdmin`), file share `\\lab-fs\Clients` with folder `ClientX` readable by `labA` only and `ClientY` readable by both, TallyPrime (educational mode), outbound internet.

| ID | Question | Pass when | Affects | Status | Result |
| --- | --- | --- | --- | --- | --- |
| L1 | Does a native Windows OpenClaw gateway run per user under RDS? What RAM per idle/busy gateway? 5 at once? | Gateways for labA and labB run concurrently from one install; RAM numbers recorded | ADR-001, ADR-003 | Not run | |
| L2 | Is loopback isolation by token real? | labB cannot use labA's gateway without labA's token; gateway refuses unauthenticated loopback | ADR-001, SECURITY | Not run | |
| L3 | How does Access Denied surface to tools? Mapped drives in child processes? | Error type captured for UNC, mapped drive, redirected folder; guard can detect reliably | F5, guard | Not run | |
| L4 | Can each session's TallyPrime use its own XML port? Does Tally company security affect XML? | Two sessions answer on different ports; behaviour with security on recorded | ADR-012 | Not run | |
| L5 | Can a gateway run as a per-user Scheduled Task while the user is logged off, with UNC access? | Gateway up after logoff; reads `ClientX` as labA | F4, ADR-005 | Not run | |
| L6 | Can the SYSTEM service start that task on demand, and how fast to ready? | `schtasks /run` (or API) from SYSTEM starts it; time to ready recorded | ADR-005 | Not run | |
| L7 | Does the pipe server get the right SID for a non-admin caller? Can labB impersonate labA? | SID correct; spoof attempts fail | SECURITY | Not run | |
| L8 | Desk autostart per session, single instance per session, global hotkey over RDP, Explorer context menu per user | All work for labA and labB at once | Desk | Not run | |
| L9 | WebView2 runtime on Server 2022 RDS; RAM per Desk instance | Installs/exists; numbers recorded | ADR-007 | Not run | |
| L10 | DPAPI CurrentUser survives logoff/logon (local and FSLogix profiles); machine scope readable by service only | Token decrypts after re-logon; other user can't decrypt | ARCHITECTURE §2 | Not run | |

## Results log

<!-- /lab-result appends here, newest first:
### L? — YYYY-MM-DD — PASS/FAIL/PARTIAL
- Environment: …
- Output summary: …
- Conclusion: …
- Changed: ADR-…, ARCHITECTURE.md …
-->
