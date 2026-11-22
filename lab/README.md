# M1 lab runbook (L1-L10)

These scripts test the assumptions in `docs/LAB_VALIDATION.md` on a real Windows Server 2022 RDS host. You build one VM, copy `lab\` onto it, run each script as the account named below, and paste the output back to Claude with `/lab-result L<n>`. Every script prints a final `RESULT L<n>: PASS | FAIL | PARTIAL` line. It also prints a `----- BEGIN PASTE ... END PASTE -----` block, and saves a transcript.

## 1. Build the lab VM

**Hypervisor.** Your laptop runs Windows 11 Home, which has no Hyper-V, so use **VirtualBox 7.x**. If your PC has Pro, Hyper-V works too. A cloud VM (Azure/AWS, Windows Server 2022) is another option.
**Size:** 4 vCPU, 16 GB RAM (12 GB minimum; L1 runs up to 6 gateways), 100 GB disk, NAT network with internet.
**OS:** Windows Server 2022 evaluation ISO (180 days, from Microsoft Evaluation Center). Choose **"Desktop Experience"**.

Do all of the following in **PowerShell as Administrator** on the VM (log in as the built-in Administrator for setup).

```powershell
# 1. Name the host and enable RDP (restarts)
Rename-Computer -NewName OMLAB-RDS
Set-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
Enable-NetFirewallRule -DisplayGroup 'Remote Desktop'
Restart-Computer

# 2. RDS Session Host role (allows more than 2 sessions; the 120-day licensing grace period is fine for a lab)
Install-WindowsFeature RDS-RD-Server -IncludeManagementTools -Restart

# 3. Users (you type each password; nothing is echoed)
foreach ($u in 'labA','labB','labAdmin') { New-LocalUser -Name $u -Password (Read-Host -AsSecureString "Password for $u") -PasswordNeverExpires }
Add-LocalGroupMember -Group 'Administrators' -Member labAdmin
Add-LocalGroupMember -Group 'Remote Desktop Users' -Member labA, labB
```

**4. File share `\\<host>\Clients`.** In the lab it can live on the same VM. Use the hostname (`\\OMLAB-RDS\Clients`) wherever the docs say `\\lab-fs\Clients`. Optional: a second small VM named `lab-fs` makes L3/L5 more realistic, because a share on the same host can behave differently for logged-off (S4U) tasks. Note which setup you used.

```powershell
$root = 'C:\Shares\Clients'
New-Item -ItemType Directory -Force "$root\ClientX", "$root\ClientY" | Out-Null
'lab file X' | Set-Content "$root\ClientX\test.txt"
'lab file Y' | Set-Content "$root\ClientY\test.txt"
# Root: admins/SYSTEM full, users may only open the root folder itself (no inheritance into children)
icacls $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(RX)'
# ClientX: labA only.  ClientY: labA and labB.  (/inheritance:r breaks inheritance from the root)
icacls "$root\ClientX" /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' 'labA:(OI)(CI)RX'
icacls "$root\ClientY" /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' 'labA:(OI)(CI)RX' 'labB:(OI)(CI)RX'
New-SmbShare -Name Clients -Path $root -FullAccess 'Administrators' -ReadAccess 'Everyone'   # NTFS decides
# Optional second L3 run: Set-SmbShare -Name Clients -FolderEnumerationMode AccessBased -Force
```

**5. TallyPrime.** Download it from tallysolutions.com and install it for all users (default `C:\Program Files\TallyPrime`). At the licence screen choose **"Work in Educational mode"**. Create one sample company.
**6. Node.** Nothing to do. L1 `-Role Install` downloads the pinned Node 24.22.3 zip (same as release.config.json) into `C:\OffManualLab\node` (SHA-256 checked). If you prefer Node on PATH, install `node-v24.22.1-x64.msi` from nodejs.org (24.22.1+ or 26.12.1+ only; Node 22/23/25 are refused by OpenClaw).
**7. Internet check:** `Test-NetConnection registry.npmjs.org -Port 443; Test-NetConnection nodejs.org -Port 443`.
**8. Do not install WebView2 yet.** L9 first records whether Server 2022 has it.

## 2. Get the scripts onto the VM

1. In Remote Desktop Connection on your laptop: *Show Options > Local Resources > More... > Drives*, tick your drive, and connect as Administrator/labAdmin.
2. Copy the repo's `lab` folder to **`C:\OffManualLab\lab`** on the VM (from `\\tsclient\C\...` in Explorer).
3. As Administrator:
   ```powershell
   Get-ChildItem C:\OffManualLab\lab -Recurse | Unblock-File
   New-Item -ItemType Directory -Force C:\OffManualLab\lab\results | Out-Null
   icacls C:\OffManualLab\lab\results /grant '*S-1-5-32-545:(OI)(CI)M'   # every user can save transcripts
   ```
4. Always start scripts like this. The policy bypass applies to that one process only:
   `powershell -ExecutionPolicy Bypass -File C:\OffManualLab\lab\<script>.ps1 <parameters>`
   "Elevated" means right-click Windows PowerShell > *Run as administrator* (labAdmin). "Normal" means an ordinary PowerShell window in that user's own RDP session.

**Two sessions at once.** L1, L2, L4, L7 and L8 need labA and labB logged on at the same time. Open **two** Remote Desktop Connection windows on your laptop to the same VM, one signed in as labA and one as labB. When a script says "sign out", use Start > user icon > *Sign out*. Closing the RDP window only disconnects the session.

## 3. Run order

The exact commands are in each script's help: `Get-Help C:\OffManualLab\lab\L1-gateway-per-user.ps1 -Full`.

| Order | ID | What it proves | Who runs it (sessions) | ~Time |
| --- | --- | --- | --- | --- |
| 1 | L9 `L9-webview2.ps1` | WebView2 runtime present/version on Server 2022 (RAM later with Desk) | labAdmin elevated, then labA | 5 min |
| 2 | L7 `L7-pipe-caller-sid.ps1` | Pipe server gets the caller's SID from the OS; body spoofing ignored; pipe-squatting with each DACL | Server: labAdmin elevated; Client: labA, labB; Squat: labB (3 sessions, both `-AclVariant`s) | 20 min |
| 3 | L10 `L10-dpapi.ps1` | DPAPI CurrentUser survives re-logon, other user can't decrypt; machine scope is readable by any user | MachineProtect: labAdmin; Protect/Verify: labA (sign out between); CrossUser: labB | 15 min |
| 4 | L3 `L3-access-denied.ps1` | Exact Access Denied error per tool (.NET, cmd, PowerShell, Node EPERM), mapped drives in tasks | labA, then labB | 10 min |
| 5 | L1 `L1-gateway-per-user.ps1` | OpenClaw gateway per user from one read-only install; RAM; ports; 5 at once; local plugin | Install: labAdmin elevated; Run: labA + labB at the same time; Count 5: labA | 45 min |
| 6 | L2 `L2-loopback-token-isolation.ps1` | labB can't use labA's gateway without the token; rate limit; no leaks | Owner: labA, Intruder: labB, at the same time | 15 min |
| 7 | L8 `L8-desk-session-behaviour.ps1` | Single instance per session, Ctrl+Space over RDP, Run-key autostart, Explorer menu | InstallMachine: labAdmin; InstallUser/Report: labA + labB at the same time | 25 min |
| 8 | L4 `L4-tally-xml-port.ps1` | Each session's Tally on its own XML port; security effect; cross-session reach | labA + labB at the same time (manual Tally steps in the header) | 40 min |
| 9 | L5 `L5-scheduled-task-logged-off.ps1` | Gateway as labA's Scheduled Task while signed out; UNC with S4U vs stored password | labAdmin elevated (labA signed out) | 20 min |
| 10 | L6 `L6-system-starts-task.ps1` | SYSTEM starts labA's task on demand; time to ready | labAdmin elevated (runs a one-off SYSTEM task) | 15 min |

Then run cleanup: L5 `-Role Cleanup -User labA -All`, plus the `-Cleanup` / `-Role Cleanup` options listed in each script's help. Each script's header lists exactly what it leaves behind.

## 4. Capture and send results

- Each run writes `C:\OffManualLab\lab\results\<ID>-<COMPUTERNAME>-<timestamp>-<role>.txt`. If that folder isn't writable, it uses `%LOCALAPPDATA%\OffManualLab\results`. L6's SYSTEM part is saved under `C:\OffManualLab\tasks\results`, and the Launcher prints it.
- Copy **the whole console output** (or the .txt file content) into the chat with Claude and type **`/lab-result L<n>`**. For two-session tests, paste both outputs.
- Scripts never print passwords or tokens (only `sha256:` hash prefixes). Don't paste anything you typed into a password prompt.
- If a script stops with `RESULT ...: FAIL` and an `unhandled_error` check, paste that too. It tells Claude what broke.
