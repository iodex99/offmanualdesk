# Install runbook (Off Manual staff)

Goal: a firm live in under 2 hours (M11). Steps marked **(to build)** are not available yet; use the manual
step given instead.

## Before the visit

1. In the console: **Add a firm** (legal name, state code, GSTIN if registered, billing email).
2. Add the firm's admins (console users) and agree the contract (billing lines).
3. On the firm page: **Create enrolment code** for the server (works once, 24 hours).
4. Ask the firm for: the RDS server's admin login, the Clients share path (`\\server\Clients`), their
   employee list (name, work email), and which AD groups map to which packs (`OM-...`).

## On the RDS server (as an administrator)

1. **Install files** **(MSI to build)**. Manually: copy the release payload to
   `C:\Program Files\OffManual\versions\<version>\` and create the junction
   `C:\Program Files\OffManual\current` → that folder:
   `mklink /J "C:\Program Files\OffManual\current" "C:\Program Files\OffManual\versions\<version>"`.
2. **Pre-flight**: `"C:\Program Files\OffManual\current\server-agent.exe" preflight -share \\server\Clients`.
   Fix every FAIL (the line under each says how). WARN items can wait but note them.
3. **Enrol**: `server-agent.exe enroll -console https://console.offmanual.in <CODE>`. It runs pre-flight again
   and registers the server; its key stays protected on this machine.
4. **Install the service**: `server-agent.exe install`. It runs as LocalSystem and restarts itself if it stops.
5. **Telegram (optional)**: create the firm's bot with BotFather, then
   `server-agent.exe telegram-setup -username <FirmBot>` and paste the token when asked. Restart the
   `OffManualAgent` service.
6. **Desk autostart** **(MSI to build)**. Manually: add `C:\Program Files\OffManual\current\desk\offmanual-desk.exe`
   to the All Users Startup folder.
7. **Explorer "Ask Off Manual"** **(MSI to build)**. Manually, in an elevated command prompt (all users):
   ```
   reg add "HKLM\Software\Classes\*\shell\OffManualDesk" /ve /d "Ask Off Manual" /f
   reg add "HKLM\Software\Classes\*\shell\OffManualDesk\command" /ve /d "\"C:\Program Files\OffManual\current\desk\offmanual-desk.exe\" --ask \"%1\"" /f
   reg add "HKLM\Software\Classes\Directory\shell\OffManualDesk" /ve /d "Ask Off Manual" /f
   reg add "HKLM\Software\Classes\Directory\shell\OffManualDesk\command" /ve /d "\"C:\Program Files\OffManual\current\desk\offmanual-desk.exe\" --ask \"%1\"" /f
   ```
   Right-clicking a file or folder then opens Desk (or brings the running one forward) with the path in the chat box.

## In the console, after enrolment

1. The firm page **Servers** section shows the server and anything pre-flight flagged.
2. **Add many people at once** with the employee list; invites go out if email is configured.
3. **Skill packs**: give Core to everyone (or an `OM-` AD group), and other packs as agreed.
4. **Settings**: lock timeout, working day end, Telegram mode, step-up for approvals.

## With the first employee

1. They sign in to the server; Desk opens. Walk through the
   [employee quick start](employee-quick-start.md): sign in, authenticator, recovery codes, PIN.
2. In Desk, run **Tasks → Build client list** to create the client directory from the Clients share and Tally.
3. Try one task (for example **GSTR-2B vs books**) end to end and open the result file.

## Done when

- The fleet board shows the server **green** with today's last-seen date.
- At least one employee is signed in, has run a task, and has seen the Review tab.
- The firm admin can open the console and sees their employees and settings.
