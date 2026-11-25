# Install runbook (Off Manual staff)

Goal: a firm live in under 2 hours (M11). The MSI does the server setup in one step; a manual fallback is below it.

## Before the visit

1. In the console: **Add a firm** (legal name, state code, GSTIN if registered, billing email).
2. Add the firm's admins (console users) and agree the contract (billing lines).
3. On the firm page: **Create enrolment code** for the server (works once, 24 hours).
4. Ask the firm for: the RDS server's admin login, the Clients share path (`\\server\Clients`), their
   employee list (name, work email), and which AD groups map to which packs (`OM-...`).

## On the RDS server (as an administrator)

1. **Install** from an elevated command prompt (the code comes from the console, step 3 above):
   ```
   msiexec /i OffManual-<version>.msi CONSOLEURL=https://console.offmanual.in ENROLCODE=<CODE> /l*v install.log
   ```
   It installs the release under `C:\Program Files\OffManual\versions\<version>\`, points
   `C:\Program Files\OffManual\current` at it, enrols the server with the console (pre-flight runs and is
   reported), installs and starts the `OffManualAgent` service (LocalSystem, restarts itself), starts Desk at every
   sign-in for all users, and adds Explorer's "Ask Off Manual". The code never appears in the log. Leave out
   `CONSOLEURL`/`ENROLCODE` to enrol later with `server-agent.exe enroll`. If enrolment fails (wrong or expired
   code), the install rolls back; make a new code and run it again.
2. **Pre-flight with the share**: `"C:\Program Files\OffManual\current\server-agent.exe" preflight -share \\server\Clients`.
   Fix every FAIL (the line under each says how). If WebView2 is reported missing, install Microsoft's
   Evergreen WebView2 runtime (not bundled in the MSI yet).
3. **Telegram (optional)**: create the firm's bot with BotFather, then
   `server-agent.exe telegram-setup -username <FirmBot>` and paste the token when asked. Restart the
   `OffManualAgent` service.

Uninstall (Apps & features, or `msiexec /x OffManual-<version>.msi`) stops and removes the service, `current`,
later updates, Desk autostart and the Explorer entry. `C:\ProgramData\OffManual` (settings, backups,
archives) is kept.

### Without the MSI (fallback)

1. Copy the release payload to `C:\Program Files\OffManual\versions\<version>\` and run
   `"C:\Program Files\OffManual\versions\<version>\server-agent.exe" setup -console https://console.offmanual.in -code <CODE>`
   (the same steps the MSI runs: `current`, enrolment, service).
2. Desk autostart: add `C:\Program Files\OffManual\current\desk\offmanual-desk.exe` to the All Users Startup folder.
3. Explorer "Ask Off Manual", in an elevated command prompt:
   ```
   reg add "HKLM\Software\Classes\*\shell\OffManualDesk" /ve /d "Ask Off Manual" /f
   reg add "HKLM\Software\Classes\*\shell\OffManualDesk\command" /ve /d "\"C:\Program Files\OffManual\current\desk\offmanual-desk.exe\" --ask \"%1\"" /f
   reg add "HKLM\Software\Classes\Directory\shell\OffManualDesk" /ve /d "Ask Off Manual" /f
   reg add "HKLM\Software\Classes\Directory\shell\OffManualDesk\command" /ve /d "\"C:\Program Files\OffManual\current\desk\offmanual-desk.exe\" --ask \"%1\"" /f
   ```

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
