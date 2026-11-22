<#
.SYNOPSIS
    L8 - Desk-like per-session behaviour under RDS: single instance per session, global hotkey over RDP for two
    users at once, autostart (HKCU Run and HKLM Run), and a per-user Explorer context-menu entry.

.DESCRIPTION
    Question (docs/LAB_VALIDATION.md L8): Desk autostart per session, single instance per session, global hotkey over
    RDP, Explorer context menu per user. Pass when all work for labA and labB at once.

    A stand-in "Desk" (WinForms window compiled with Add-Type) that:
      - takes mutex "Local\OffManualDeskLab" (per-session namespace). A second launch in the SAME session finds the
        mutex, forwards its arguments (e.g. the context-menu path) to the running instance through an inbox file,
        logs "second_instance_refused" and exits. labA and labB each get their own instance (different sessions).
      - also opens "Global\OffManualDeskLabGlobalProbe" only to show what a Global\ name would do (another session
        already holding it = a Global\ single-instance mutex would wrongly block the second user).
      - registers Ctrl+Space with RegisterHotKey (MOD_CONTROL|MOD_NOREPEAT, VK_SPACE) and counts WM_HOTKEY presses.
        Registration failure is logged with its Win32 error (1409 = ERROR_HOTKEY_ALREADY_REGISTERED).
      - logs everything to %LOCALAPPDATA%\OffManualLab\L8\app.log (it is usually started hidden, so -Role Report
        turns that log into the transcript + PASS/FAIL).

    Roles:
      -Role InstallUser     labA and labB (normal PowerShell): HKCU Run value "OffManualDeskLab" and context-menu
                            verb "Ask Off Manual (lab)" under HKCU\Software\Classes\*\shell, Directory\shell and
                            Directory\Background\shell.
      -Role InstallMachine  labAdmin (elevated): HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run value
                            "OffManualDeskLabAll" (starts for EVERY user who logs on, labAdmin included).
      -Role App             the stand-in itself (started by Run keys, the context menu, or by hand).
      -Role Report          each user: summarises app.log for this session, keyboard layouts (IME), and current
                            registrations. Paste this output back.
      -Cleanup              (with no -Role or any role) removes this user's HKCU entries and log folder;
                            add -Machine (elevated) to remove the HKLM Run value too.

    Docs:
      - Kernel object namespaces (Local\ = per session, Global\ = all sessions):
        https://learn.microsoft.com/en-us/windows/win32/termserv/kernel-object-namespaces
      - RegisterHotKey / WM_HOTKEY / MOD_NOREPEAT: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey
      - Run keys: https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys
      - Context-menu verbs under HKCU\Software\Classes (per-user registration):
        https://learn.microsoft.com/en-us/windows/win32/shell/context-menu-handlers
        https://learn.microsoft.com/en-us/windows/win32/sysinfo/merged-view-of-hkey-classes-root

    Prerequisites: lab folder at C:\OffManualLab\lab (readable by Users) - the Run/context-menu commands point at
    this script's own path. labA and labB logged on over RDP at the same time for the hotkey test.

    Exact sequence:
      1. labAdmin (elevated):  ...\L8-desk-session-behaviour.ps1 -Role InstallMachine
      2. labA and labB (each): ...\L8-desk-session-behaviour.ps1 -Role InstallUser
      3. labA and labB: SIGN OUT and sign in again (RDP). Two hidden PowerShell windows start the stand-in (HKCU Run +
         HKLM Run): one wins, the other logs "second_instance_refused" - that is the single-instance test.
         A small window titled "Off Manual Desk (lab)" should be visible in each session.
      4. In BOTH sessions at the same time: press Ctrl+Space 3 times (the window counter goes up even when another
         app has focus). If your keyboard has an IME (e.g. Chinese/Japanese), note whether Ctrl+Space also toggled it.
      5. In each session: open Explorer, right-click any file, then a folder, then empty folder background. Is "Ask Off
         Manual (lab)" in the menu (Windows Server 2022 shows the classic menu)? Click it once each time.
      6. In each session: start it once more by hand: ...\L8-desk-session-behaviour.ps1 -Role App  (should exit quickly
         with "already running in this session").
      7. In each session: ...\L8-desk-session-behaviour.ps1 -Role Report    -> paste the output.
      8. Cleanup: each user: ...\L8-desk-session-behaviour.ps1 -Cleanup ; labAdmin elevated: ...\L8-... -Cleanup -Machine
         (close the stand-in windows first).

    Pass criteria (measurable, from -Role Report, per user):
      - autostart_hkcu and autostart_hklm: app.log has a launch with reason HKCU-Run and one with HKLM-Run this logon.
      - single_instance: exactly one "instance_started" per logon; >= 1 "second_instance_refused" (autostart duplicate
        or manual step 6).
      - per_session: Local\ mutex created in this session while another session's instance existed (global probe shows
        "already existed" for the second user) - i.e. both users ran one instance at once.
      - hotkey: RegisterHotKey succeeded and >= 1 WM_HOTKEY received.
      - context_menu: >= 1 launch with reason ContextMenu carrying a path (forwarded to the running instance).
      L8 PASS = all of the above PASS for labA and labB.

    Leaves behind until -Cleanup: HKCU Run value + three HKCU\Software\Classes\...\shell\OffManualDeskLab keys per user,
    HKLM Run value (labAdmin), %LOCALAPPDATA%\OffManualLab\L8 per user. Transcripts in lab\results.
#>
[CmdletBinding()]
param(
    [ValidateSet('InstallUser', 'InstallMachine', 'App', 'Report', '')][string]$Role = '',
    [string]$LaunchReason = 'Manual',
    [string]$TargetPath = '',
    [int]$AutoExitSec = 0,
    [switch]$Cleanup,
    [switch]$Machine
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
trap { Write-LabUnhandled $_; break }

$logDir = Join-Path $env:LOCALAPPDATA 'OffManualLab\L8'
$logFile = Join-Path $logDir 'app.log'
$inbox = Join-Path $logDir 'inbox.txt'
$verbKey = 'OffManualDeskLab'
$verbText = 'Ask Off Manual (lab)'
$runUserName = 'OffManualDeskLab'
$runMachineName = 'OffManualDeskLabAll'
$classRoots = @('HKCU:\Software\Classes\*\shell', 'HKCU:\Software\Classes\Directory\shell', 'HKCU:\Software\Classes\Directory\Background\shell')
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$self = $PSCommandPath

function Write-AppLog {
    param([string]$EventName, [string]$Detail = '')
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $line = (Get-LabTimestamp) + "`tsession=" + [System.Diagnostics.Process]::GetCurrentProcess().SessionId + "`tpid=" + $PID + "`tevent=" + $EventName + "`tdetail=" + ($Detail -replace "[`t`r`n]", ' ')
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Get-LaunchCommand {
    param([string]$Reason, [string]$PathToken = '')
    $cmd = '"' + $psExe + '" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $self + '" -Role App -LaunchReason ' + $Reason
    if ($PathToken) { $cmd += ' -TargetPath "' + $PathToken + '"' }
    return $cmd
}

# ------------------------------------------------------------------------------------------------
if ($Cleanup) {
    $null = Start-LabTranscript -Id 'L8' -Suffix ('Cleanup-' + $env:USERNAME)
    $null = Write-SessionInfo
    try { Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $runUserName -ErrorAction Stop; Add-LabCheck 'remove_hkcu_run' 'PASS' 'removed' } catch { Add-LabCheck 'remove_hkcu_run' 'INFO' 'not present' }
    foreach ($root in $classRoots) {
        $k = Join-Path $root $verbKey
        if (Test-Path -LiteralPath $k) { Remove-Item -LiteralPath $k -Recurse -Force; Add-LabCheck ('remove_' + ($root -replace '[^A-Za-z]', '_')) 'PASS' $k }
    }
    if ($Machine) {
        Assert-LabElevated -Why 'removing the HKLM Run value'
        try { Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -Name $runMachineName -ErrorAction Stop; Add-LabCheck 'remove_hklm_run' 'PASS' 'removed' } catch { Add-LabCheck 'remove_hklm_run' 'INFO' 'not present' }
    }
    if (Test-Path -LiteralPath $logDir) { Remove-Item -LiteralPath $logDir -Recurse -Force -ErrorAction SilentlyContinue; Add-LabCheck 'remove_log' 'PASS' $logDir }
    Write-Result
    return
}

if ($Role -eq '') { throw 'Pass -Role InstallUser | InstallMachine | App | Report, or -Cleanup.' }

# ------------------------------------------------------------------------------------------------
if ($Role -eq 'InstallUser') {
    $null = Start-LabTranscript -Id 'L8' -Suffix ('InstallUser-' + $env:USERNAME)
    $s = Write-SessionInfo
    if ($s.IsElevated) { Write-LabWarn 'Run InstallUser from a normal PowerShell as labA / labB (HKCU of the elevated user is the same, but keep it realistic).' }
    New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $runUserName -Value (Get-LaunchCommand -Reason 'HKCU-Run') -PropertyType String -Force | Out-Null
    Add-LabCheck 'hkcu_run' 'PASS' ('HKCU Run ' + $runUserName)
    $targets = @(@{ Root = $classRoots[0]; Token = '%1' }, @{ Root = $classRoots[1]; Token = '%1' }, @{ Root = $classRoots[2]; Token = '%V' })
    foreach ($t in $targets) {
        $k = Join-Path $t.Root $verbKey
        New-Item -Path $k -Force | Out-Null
        Set-ItemProperty -LiteralPath $k -Name '(default)' -Value $verbText
        New-Item -Path (Join-Path $k 'command') -Force | Out-Null
        Set-ItemProperty -LiteralPath (Join-Path $k 'command') -Name '(default)' -Value (Get-LaunchCommand -Reason 'ContextMenu' -PathToken $t.Token)
        Add-LabCheck ('verb_' + ($t.Root -replace '^HKCU:\\Software\\Classes\\', '' -replace '[^A-Za-z*]', '_')) 'PASS' $k
    }
    Write-Host '>>> Now sign out and sign in again, then follow steps 3-7 in the script header.'
    Write-Result
    return
}

if ($Role -eq 'InstallMachine') {
    $null = Start-LabTranscript -Id 'L8' -Suffix 'InstallMachine'
    $null = Write-SessionInfo
    Assert-LabElevated -Why 'writing HKLM Run'
    New-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -Name $runMachineName -Value (Get-LaunchCommand -Reason 'HKLM-Run') -PropertyType String -Force | Out-Null
    Add-LabCheck 'hklm_run' 'PASS' ('HKLM Run ' + $runMachineName + ' -> ' + $self)
    $acl = Get-Acl -LiteralPath $self
    $usersRead = @($acl.Access | Where-Object { $_.IdentityReference.Value -match 'Users|Everyone|Authenticated' -and $_.AccessControlType -eq 'Allow' })
    if ($usersRead.Count -gt 0) { Add-LabCheck 'script_readable_by_users' 'PASS' $self } else { Add-LabCheck 'script_readable_by_users' 'WARN' ($self + ' may not be readable by labA/labB; put the lab folder at C:\OffManualLab\lab') }
    Write-Result
    return
}

# ------------------------------------------------------------------------------------------------
if ($Role -eq 'App') {
    $sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    $createdNew = $false
    $mutex = New-Object System.Threading.Mutex($true, 'Local\OffManualDeskLab', [ref]$createdNew)
    if (-not $createdNew) {
        Write-AppLog -EventName 'second_instance_refused' -Detail ('reason=' + $LaunchReason + ' path=' + $TargetPath)
        if ($TargetPath) { Add-Content -LiteralPath $inbox -Value ($LaunchReason + "`t" + $TargetPath) -Encoding UTF8 }
        Write-Host ('Off Manual Desk (lab) is already running in session ' + $sessionId + '; forwarded the request and exiting.')
        $mutex.Dispose()
        return
    }
    $gNew = $false
    $gmutex = $null
    $gDetail = ''
    try {
        $gmutex = New-Object System.Threading.Mutex($false, 'Global\OffManualDeskLabGlobalProbe', [ref]$gNew)
        $gDetail = $(if ($gNew) { 'created (no other session holds it)' } else { 'already existed (another session holds it - a Global\ single-instance mutex would block this user)' })
    } catch { $gDetail = 'error ' + (Format-LabError $_) }
    Write-AppLog -EventName 'instance_started' -Detail ('reason=' + $LaunchReason + ' path=' + $TargetPath + ' user=' + $env:USERNAME + ' local_mutex=created global_probe=' + $gDetail)
    if ($TargetPath) { Write-AppLog -EventName 'path_received' -Detail ('via=' + $LaunchReason + ' path=' + $TargetPath) }

    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    if (-not ('OmLabDeskForm' -as [type])) {
        Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -Language CSharp -TypeDefinition @'
using System;
using System.IO;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;

public class OmLabDeskForm : Form
{
    [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll", SetLastError = true)] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    const int WM_HOTKEY = 0x0312;
    const uint MOD_CONTROL = 0x0002, MOD_NOREPEAT = 0x4000, VK_SPACE = 0x20;
    const int HOTKEY_ID = 0x4F4D;

    public int HotkeyCount;
    public bool HotkeyRegistered;
    public int HotkeyError;
    readonly string logPath, inboxPath;
    readonly Label label;
    readonly Timer timer;
    string header;

    public OmLabDeskForm(string logPath, string inboxPath, string header)
    {
        this.logPath = logPath; this.inboxPath = inboxPath; this.header = header;
        Text = "Off Manual Desk (lab)";
        Width = 520; Height = 220; TopMost = true; StartPosition = FormStartPosition.CenterScreen;
        label = new Label(); label.Dock = DockStyle.Fill; label.Font = new Font("Segoe UI", 10);
        Controls.Add(label);
        timer = new Timer(); timer.Interval = 1000; timer.Tick += (s, e) => PollInbox(); timer.Start();
        Refresh2("");
    }

    void Log(string evt, string detail)
    {
        string line = DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffzzz") + "\tsession=" + System.Diagnostics.Process.GetCurrentProcess().SessionId +
                      "\tpid=" + System.Diagnostics.Process.GetCurrentProcess().Id + "\tevent=" + evt + "\tdetail=" + detail.Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ');
        try { File.AppendAllText(logPath, line + Environment.NewLine); } catch { }
    }

    void Refresh2(string extra)
    {
        label.Text = header + "\r\nHotkey Ctrl+Space: " + (HotkeyRegistered ? "registered" : ("NOT registered, error " + HotkeyError)) +
                     "\r\nHotkey presses: " + HotkeyCount + (extra.Length > 0 ? "\r\nLast request: " + extra : "") +
                     "\r\n(Close this window to end the test instance.)";
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        HotkeyRegistered = RegisterHotKey(Handle, HOTKEY_ID, MOD_CONTROL | MOD_NOREPEAT, VK_SPACE);
        HotkeyError = HotkeyRegistered ? 0 : Marshal.GetLastWin32Error();
        Log("hotkey_register", HotkeyRegistered ? "ok" : ("failed win32=" + HotkeyError));
        Refresh2("");
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        if (HotkeyRegistered) UnregisterHotKey(Handle, HOTKEY_ID);
        Log("instance_closed", "hotkey_presses=" + HotkeyCount);
        base.OnFormClosed(e);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == HOTKEY_ID)
        {
            HotkeyCount++;
            Log("hotkey_pressed", "count=" + HotkeyCount);
            Refresh2("");
            Activate();
        }
        base.WndProc(ref m);
    }

    void PollInbox()
    {
        try
        {
            if (!File.Exists(inboxPath)) return;
            string[] lines = File.ReadAllLines(inboxPath);
            File.Delete(inboxPath);
            foreach (string l in lines)
            {
                if (l.Trim().Length == 0) continue;
                Log("forwarded_request", l);
                Refresh2(l);
            }
        }
        catch { }
    }
}
'@
    }
    $header = 'User ' + $env:USERNAME + ' | session ' + $sessionId + ' | started by ' + $LaunchReason
    if ($TargetPath) { $header += "`r`nPath: " + $TargetPath }
    $form = New-Object OmLabDeskForm($logFile, $inbox, $header)
    if ($AutoExitSec -gt 0) {
        $t = New-Object System.Windows.Forms.Timer
        $t.Interval = $AutoExitSec * 1000
        $t.add_Tick({ $form.Close() })
        $t.Start()
    }
    [System.Windows.Forms.Application]::Run($form)
    if ($null -ne $gmutex) { $gmutex.Dispose() }
    $mutex.ReleaseMutex()
    $mutex.Dispose()
    return
}

# ------------------------------------------------------------------------------------------------
# Report
$null = Start-LabTranscript -Id 'L8' -Suffix ('Report-' + $env:USERNAME)
$s = Write-SessionInfo
# "This logon" = since the oldest explorer.exe in this session started.
$logonTime = $null
$explorer = @(Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $s.SessionId } | Sort-Object StartTime | Select-Object -First 1)
if ($explorer.Count -gt 0) { $logonTime = $explorer[0].StartTime }
Set-LabValue 'session_logon_approx' $(if ($logonTime) { $logonTime.ToString('yyyy-MM-ddTHH:mm:ss') } else { 'unknown' })

if (-not (Test-Path -LiteralPath $logFile)) {
    Add-LabCheck 'app_log' 'FAIL' ('no ' + $logFile + ' - the stand-in never ran for this user')
    Write-Result; return
}
$rows = @()
foreach ($line in (Get-Content -LiteralPath $logFile)) {
    $parts = $line -split "`t"
    if ($parts.Count -lt 5) { continue }
    $ts = $null
    try { $ts = [datetime]::Parse($parts[0]) } catch { continue }
    $rows += [pscustomobject]@{ Time = $ts; Session = ($parts[1] -replace '^session=', ''); Event = ($parts[3] -replace '^event=', ''); Detail = ($parts[4] -replace '^detail=', '') }
}
if ($logonTime) { $rows = @($rows | Where-Object { $_.Time -ge $logonTime.AddMinutes(-1) }) }
$rows = @($rows | Where-Object { $_.Session -eq [string]$s.SessionId })
Write-LabSection ('app.log events for this session since logon (' + $rows.Count + ')')
foreach ($r in $rows) { Write-LabInfo ($r.Time.ToString('HH:mm:ss') + ' ' + $r.Event + ' ' + $r.Detail) }

$started = @($rows | Where-Object { $_.Event -eq 'instance_started' })
$refused = @($rows | Where-Object { $_.Event -eq 'second_instance_refused' })
$hkReg = @($rows | Where-Object { $_.Event -eq 'hotkey_register' })
$hkPress = @($rows | Where-Object { $_.Event -eq 'hotkey_pressed' })
$ctx = @($rows | Where-Object { ($_.Event -eq 'instance_started' -or $_.Event -eq 'second_instance_refused') -and $_.Detail -match 'reason=ContextMenu path=\S' })
$fwd = @($rows | Where-Object { $_.Event -eq 'forwarded_request' -or $_.Event -eq 'path_received' })
$allLaunch = @($started + $refused)
Set-LabValue 'instances_started' $started.Count
Set-LabValue 'second_instances_refused' $refused.Count
Set-LabValue 'hotkey_register' (@($hkReg | ForEach-Object { $_.Detail }) -join ',')
Set-LabValue 'hotkey_presses' $hkPress.Count
Set-LabValue 'context_menu_launches' $ctx.Count
Set-LabValue 'paths_received_by_running_instance' $fwd.Count

if (@($allLaunch | Where-Object { $_.Detail -match 'reason=HKCU-Run' }).Count -gt 0) { Add-LabCheck 'autostart_hkcu' 'PASS' 'HKCU Run launch logged this logon' } else { Add-LabCheck 'autostart_hkcu' 'FAIL' 'no HKCU-Run launch this logon' }
if (@($allLaunch | Where-Object { $_.Detail -match 'reason=HKLM-Run' }).Count -gt 0) { Add-LabCheck 'autostart_hklm' 'PASS' 'HKLM Run launch logged this logon' } else { Add-LabCheck 'autostart_hklm' 'FAIL' 'no HKLM-Run launch this logon' }
if ($started.Count -eq 1 -and $refused.Count -ge 1) { Add-LabCheck 'single_instance' 'PASS' ('1 instance, ' + $refused.Count + ' refused duplicate launch(es)') }
elseif ($started.Count -eq 1) { Add-LabCheck 'single_instance' 'WARN' '1 instance but no duplicate launch tried (run step 6)' }
else { Add-LabCheck 'single_instance' 'FAIL' ($started.Count.ToString() + ' instances started in this session this logon') }
if ($started.Count -ge 1) {
    $g = $started[0].Detail
    if ($g -match 'global_probe=already existed') { Add-LabCheck 'per_session' 'PASS' 'started while another session already ran its instance (Local\ mutex is per session; Global\ would have blocked)' }
    else { Add-LabCheck 'per_session' 'INFO' 'this session started first; the other user''s Report shows the concurrent case' }
    Set-LabValue 'global_probe' $g
}
if (@($hkReg | Where-Object { $_.Detail -eq 'ok' }).Count -gt 0 -and $hkPress.Count -ge 1) { Add-LabCheck 'hotkey' 'PASS' ('registered; ' + $hkPress.Count + ' WM_HOTKEY received') }
elseif (@($hkReg | Where-Object { $_.Detail -eq 'ok' }).Count -gt 0) { Add-LabCheck 'hotkey' 'WARN' 'registered but no presses received (press Ctrl+Space, step 4)' }
else { Add-LabCheck 'hotkey' 'FAIL' ('RegisterHotKey: ' + (@($hkReg | ForEach-Object { $_.Detail }) -join ',')) }
if ($ctx.Count -ge 1 -and $fwd.Count -ge 1) { Add-LabCheck 'context_menu' 'PASS' ($ctx.Count.ToString() + ' context-menu launch(es) with a path; delivered to the running instance') }
elseif ($ctx.Count -ge 1) { Add-LabCheck 'context_menu' 'WARN' 'context-menu launch logged but the path did not reach the running instance' }
else { Add-LabCheck 'context_menu' 'FAIL' 'no context-menu launch logged (step 5)' }

Write-LabSection 'Keyboard layouts / IME (Ctrl+Space conflict risk)'
try {
    # Get-WinUserLanguageList returns ONE List object; enumerate it with foreach.
    $langs = New-Object System.Collections.ArrayList
    foreach ($l in (Get-WinUserLanguageList)) { $null = $langs.Add($l) }
    $parts = New-Object System.Collections.ArrayList
    foreach ($l in $langs) { $null = $parts.Add([string]$l.LanguageTag + '[' + ((@($l.InputMethodTips) | ForEach-Object { [string]$_ }) -join ';') + ']') }
    $txt = $parts -join ', '
    Set-LabValue 'input_languages' $txt
    $ime = @($langs | Where-Object { $_.LanguageTag -match '^(zh|ja|ko)' })
    Add-LabCheck 'ime_present' 'INFO' ('languages: ' + $txt + '; East Asian IME present=' + ($ime.Count -gt 0) + ' (Ctrl+Space toggles those IMEs)')
} catch { Add-LabCheck 'ime_present' 'INFO' ('Get-WinUserLanguageList failed: ' + (Format-LabError $_)) }

Write-LabSection 'Registrations'
$hkcuRun = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue)
$hasHkcu = ($null -ne $hkcuRun -and $null -ne $hkcuRun.PSObject.Properties[$runUserName])
$hklmRun = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue)
$hasHklm = ($null -ne $hklmRun -and $null -ne $hklmRun.PSObject.Properties[$runMachineName])
$verbs = @($classRoots | Where-Object { Test-Path -LiteralPath (Join-Path $_ $verbKey) })
Set-LabValue 'registered_hkcu_run' $hasHkcu
Set-LabValue 'registered_hklm_run' $hasHklm
Set-LabValue 'registered_verbs' $verbs.Count
Add-LabCheck 'manual_observations' 'INFO' 'Tell Claude: did "Ask Off Manual (lab)" appear for a file, a folder and folder background in Explorer? Did Ctrl+Space work in both sessions at the same time? Any IME toggle?'
Write-Result
