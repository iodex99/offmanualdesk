# Security review (M11), first pass: 23-11-2026

Against the checklist in `SECURITY.md` §6. "Code + tests" means enforced in code and covered by automated
tests (CI); "lab" means it still needs the Windows Server 2022 RDS lab (`lab/`, `LAB_VALIDATION.md`) with real
accounts. Nothing here is marked done on the strength of a lab run that hasn't happened.

| # | Item | Status | Evidence | Remaining |
| --- | --- | --- | --- | --- |
| 1 | Pipe ACL and SID derivation tested with a second user trying to call as the first | Code + tests; lab | DACL `D:P(A;;GA;;;SY)(A;;GA;;;<owner>)(A;;0x12008b;;;AU)`; caller SID from the client process token (`internal/pipe`); CI installs the real LocalSystem service and proves a GENERIC_WRITE client is refused; strict params mean no method accepts a SID from the body (tested: `auth.bindComplete` with an extra `sid` field is refused) | L7: a second Windows account calls as the first |
| 2 | Gateway token isolation across two RDS sessions | Code + tests; lab | 256-bit token per lease, only its hash plus a DPAPI copy for the relay stored; token only in the gateway's environment; `rateLimit.exemptLoopback: false`; Desk config tests | L2: second session connects to the first's port |
| 3 | Access-denied path on UNC, mapped drive, OneDrive folder | Code + tests; lab | Guard tool-result middleware rewrites denials and stops the run; `delete_files` reports denials without retrying | L3 on each path type |
| 4 | Review queue cannot be bypassed by any skill in the pack | Done for v1 | Irreversible actions exist only as proposal tools (ADR-041); pack allowlist blocks tools no pack lists (ADR-043); built-in delete commands blocked; approvals only through gateway methods the agent can't call; approval runs once | Re-check when each new pack adds tools |
| 5 | Telegram text-only blocks attachments, links to files and base64 dumps | Done (fixed in this review) | Incoming files refused without download; **new:** replies lose long encoded runs and local links (`file://`, localhost, 127.0.0.1) before sending (`internal/telegram/sanitize.go`, tests) | — |
| 6 | Console payloads inspected: no client content | Done | Every agent endpoint parses a strict schema and refuses unknown fields: enrol, heartbeat, policy, audit summary (counts), usage (counts), support bundle (metadata, shown to the employee first), bind (code + SID), releases; tests send unknown fields and file-like fields and get 400 | — |
| 7 | Update with bad signature / bad hash refused | Done | Stager tests: tampered payload, foreign key, console mismatch, non-HTTPS, tampered staged copy quarantined (`internal/update`) | Authenticode check on binaries (WinVerifyTrust) still to build |
| 8 | Offboarding leaves no running process, token or Telegram link | Done in code; lab | Disabling removes the day grant, lease (token hash and DPAPI copy) and Telegram link; the guard refuses every turn for a disabled employee; **new:** Desk checks every minute and stops the gateway, showing a plain message | L-offboard: confirm the process is gone on the RDS host |
| 9 | Secrets scan on repo history | Partly | gitleaks on every push with full checkout (`ci.yml`); `.gitleaks.toml` allowlists only the public test vector | Run one full-history scan (`gitleaks detect --log-opts=--all`) before the first pilot |

## Other findings in this pass

- **Enrolment could fail on a long pre-flight message** (fixed): the report is now cut to the console's limits
  before sending.
- **Problem reports**: free text is the only path for client details; the Desk screen warns and the console caps
  it at 500 characters (ADR-050).
- **Admin authenticator reset** can force re-enrolment but not enrol for someone else (ADR-049).
