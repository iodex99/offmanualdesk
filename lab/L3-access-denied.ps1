<#
.SYNOPSIS
    L3 - How does Access Denied surface to tools (PowerShell/.NET, cmd, Node), via UNC, a mapped drive,
    child processes and scheduled-task processes? Can the guard detect it reliably?

.DESCRIPTION
    Question (docs/LAB_VALIDATION.md L3): How does Access Denied surface to tools? Mapped drives in child processes?
    Feeds ARCHITECTURE.md flow F5 step 3 (guard converts EACCES / Windows error 5 into access_denied{path}).

    Run as labA AND as labB (each in their own RDP session, normal PowerShell, one after the other is fine).
    For each of \\<host>\Clients\ClientX\test.txt and ...\ClientY\test.txt it records, per method:
      ps-unc         [System.IO.File]::ReadAllText(UNC)          -> .NET exception type, HResult, Win32 code
      ps-unc-list    [System.IO.Directory]::GetFiles(UNC folder)
      ps-unc-write   create + delete a temp file in the folder (expected denied: shares are read-only for users)
      ps-mapped      same read via a drive letter mapped in this session with "net use Z: ... /persistent:no"
      cmd-unc / cmd-mapped     cmd.exe /c type <path>             -> exit code + stderr text
      psexec-unc / -mapped     powershell.exe -Command Get-Content <path> (what OpenClaw's exec tool falls back to on
                               Windows) -> exit code + the exact error text PowerShell prints
      node-unc / node-mapped   node fs.readFileSync(<path>)        -> err.code, errno, syscall. Expected EPERM, not EACCES:
                               libuv maps Win32 ERROR_ACCESS_DENIED (5) to EPERM (docs/OPENCLAW_NOTES.md section 5;
                               confirmed on the Windows 11 dev box: code=EPERM errno=-4048 syscall=open)
    Then, mapped drive visibility in processes started by Task Scheduler for the same user:
      task-interactive   task with LogonType Interactive (runs in this logon session)
      task-s4u           task with LogonType S4U ("Do not store password") - also shows whether UNC works
    Both tasks are registered for the CURRENT user only and unregistered at the end.
    Optional: -RedirectedDeniedPath / -OneDriveDeniedPath to run the same matrix on a redirected-folder or
    OneDrive path the user cannot read (skipped with a note if not given). Documents redirection and
    %OneDrive% presence are recorded either way.

    Note: if the share uses Access-Based Enumeration, a denied folder can look like "not found"
    (DirectoryNotFound / ENOENT) instead of "access denied". The script records whether ClientX is visible
    in the share root listing. README optional step: re-run with ABE on.
    Note: the lab file share may be on the same VM as the RDS host. A same-host share can behave differently
    from a real separate file server for S4U tasks (no network credentials). Record which you used.

    Docs: Task Scheduler logon types / S4U: https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks
          New-ScheduledTaskPrincipal: https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal
          System error codes (5 = ERROR_ACCESS_DENIED): https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-
          Node fs errors (err.code/errno/syscall): https://nodejs.org/api/errors.html#class-systemerror

    Prerequisites: share built per README (\\<host>\Clients, ClientX readable by labA only, ClientY by labA+labB,
    each containing test.txt). Node on PATH for the node-* rows (any version; skipped if missing).

    Exact commands:
      labA:  powershell -ExecutionPolicy Bypass -File C:\OffManualLab\lab\L3-access-denied.ps1 -SharePath \\<host>\Clients
      labB:  powershell -ExecutionPolicy Bypass -File C:\OffManualLab\lab\L3-access-denied.ps1 -SharePath \\<host>\Clients
      (Optional) -RedirectedDeniedPath \\lab-fs\Redirected\labA\Documents\secret.txt  -OneDriveDeniedPath <path>

    What to paste back: both outputs or lab\results\L3-*.txt, then /lab-result L3.

    Pass criteria (measurable):
      - Expected access matches for every read method: labA reads ClientX and ClientY; labB reads ClientY and
        is refused on ClientX (any method succeeding where denial is expected = FAIL).
      - Every refusal produced a captured error signature (type/HResult/Win32 code, cmd exit code + text,
        Node err.code/errno). Signatures per method recorded in the paste block (sig.* keys).
      - guard_detectable = PASS when every denial maps to one of: Win32 5, HResult 0x80070005,
        UnauthorizedAccess(Exception/Error), Node EPERM/EACCES, cmd "Access is denied", PowerShell "Access to the path
        ... is denied".
      - Mapped drive visibility in task-interactive and task-s4u recorded (INFO).

    Leaves behind: nothing persistent. The mapped drive (if this script created it) is removed, both tasks are
    unregistered, %LOCALAPPDATA%\OffManualLab\L3 is deleted unless -KeepFiles. -Cleanup removes leftovers
    from an interrupted run. Transcript in lab\results.
#>
[CmdletBinding()]
param(
    [string]$SharePath = '',
    [string]$DriveLetter = 'Z',
    [string]$FileName = 'test.txt',
    [ValidateSet('Auto', 'Allow', 'Deny')][string]$ExpectClientX = 'Auto',
    [string]$RedirectedDeniedPath = '',
    [string]$OneDriveDeniedPath = '',
    [switch]$SkipTaskTest,
    [switch]$KeepFiles,
    [switch]$Cleanup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
trap { Write-LabUnhandled $_; break }

if (-not $SharePath) { $SharePath = '\\' + $env:COMPUTERNAME + '\Clients' }
$SharePath = $SharePath.TrimEnd('\')
$DriveLetter = $DriveLetter.TrimEnd(':').ToUpperInvariant()
$workDir = Join-Path $env:LOCALAPPDATA 'OffManualLab\L3'
$taskPrefix = 'OffManualLab-L3-' + $env:USERNAME

$null = Start-LabTranscript -Id 'L3' -Suffix $env:USERNAME
$session = Write-SessionInfo
Set-LabValue 'share' $SharePath

function Remove-L3Tasks {
    foreach ($kind in @('Interactive', 'S4U')) {
        $n = $taskPrefix + '-' + $kind
        try { Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction Stop } catch { $null = $_ }
    }
}

if ($Cleanup) {
    Remove-L3Tasks
    if (Test-Path -LiteralPath $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
    Add-LabCheck 'cleanup' 'PASS' ('tasks ' + $taskPrefix + '-* removed; ' + $workDir + ' removed. Remove a leftover mapping with: net use ' + $DriveLetter + ': /delete /y')
    Write-Result
    return
}

if ($ExpectClientX -eq 'Auto') {
    if ($env:USERNAME -ieq 'labA') { $ExpectClientX = 'Allow' }
    elseif ($env:USERNAME -ieq 'labB') { $ExpectClientX = 'Deny' }
    else { throw 'Run as labA or labB, or pass -ExpectClientX Allow|Deny.' }
}
Set-LabValue 'expect_clientx' $ExpectClientX
if (-not (Test-Path -LiteralPath $workDir)) { New-Item -ItemType Directory -Path $workDir -Force | Out-Null }

$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeExe = ''
if ($null -ne $nodeCmd) { $nodeExe = $nodeCmd.Source }
elseif (Test-Path -LiteralPath 'C:\OffManualLab\node\node.exe') { $nodeExe = 'C:\OffManualLab\node\node.exe' }   # installed by L1 -Role Install
Set-LabValue 'node' $nodeExe

# Node probe: prints one JSON line {ok, code, errno, syscall, message}
$nodeProbe = Join-Path $workDir 'probe.js'
Write-LabTextFile -Path $nodeProbe -Text @'
const fs = require('fs');
const p = process.argv[2];
try { fs.readFileSync(p); console.log(JSON.stringify({ ok: true })); }
catch (e) { console.log(JSON.stringify({ ok: false, code: e.code, errno: e.errno, syscall: e.syscall, message: String(e.message).split('\n')[0] })); }
'@

$denySignatures = New-Object System.Collections.ArrayList

function Test-Detectable {
    param([string]$Sig)
    return ($Sig -match 'win32=5\b' -or $Sig -match '0x80070005' -or $Sig -match 'UnauthorizedAccess' -or
            $Sig -match 'code=EPERM' -or $Sig -match 'code=EACCES' -or $Sig -match 'Access is denied' -or
            $Sig -match 'Access to the path .* is denied')
}

function Record-Attempt {
    param([string]$Name, [bool]$Ok, [string]$Signature, [string]$Expect)
    Set-LabValue ('sig.' + $Name) $(if ($Ok) { 'OK' } else { $Signature })
    if ($Expect -eq 'Info') { Add-LabCheck $Name 'INFO' $(if ($Ok) { 'succeeded' } else { $Signature }); if (-not $Ok) { $null = $denySignatures.Add($Signature) }; return }
    if ($Expect -eq 'Allow') {
        if ($Ok) { Add-LabCheck $Name 'PASS' 'read OK as expected' } else { Add-LabCheck $Name 'FAIL' ('expected access but got: ' + $Signature) }
    } else {
        if ($Ok) { Add-LabCheck $Name 'FAIL' 'READ SUCCEEDED but access should be denied' }
        else { Add-LabCheck $Name 'PASS' $Signature; $null = $denySignatures.Add($Signature) }
    }
}

function Invoke-ReadMatrix {
    <# Runs every read method against one file path. Prefix is used in check names. #>
    param([string]$Prefix, [string]$UncFile, [string]$MappedFile, [string]$Expect)
    # .NET read via UNC
    try { $null = [System.IO.File]::ReadAllText($UncFile); Record-Attempt ($Prefix + '.ps-unc') $true '' $Expect }
    catch { Record-Attempt ($Prefix + '.ps-unc') $false (Format-LabError $_) $Expect }
    # .NET list folder
    $dir = Split-Path -Parent $UncFile
    try { $null = [System.IO.Directory]::GetFiles($dir); Record-Attempt ($Prefix + '.ps-unc-list') $true '' $Expect }
    catch { Record-Attempt ($Prefix + '.ps-unc-list') $false (Format-LabError $_) $Expect }
    # .NET write (expected denied for everyone; INFO only)
    $wf = Join-Path $dir ('l3-write-' + $env:USERNAME + '-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try { [System.IO.File]::WriteAllText($wf, 'lab'); Remove-Item -LiteralPath $wf -Force -ErrorAction SilentlyContinue; Record-Attempt ($Prefix + '.ps-unc-write') $true '' 'Info' }
    catch { Record-Attempt ($Prefix + '.ps-unc-write') $false (Format-LabError $_) 'Info' }
    # .NET via mapped drive
    if ($MappedFile) {
        try { $null = [System.IO.File]::ReadAllText($MappedFile); Record-Attempt ($Prefix + '.ps-mapped') $true '' $Expect }
        catch { Record-Attempt ($Prefix + '.ps-mapped') $false (Format-LabError $_) $Expect }
    }
    # cmd.exe child
    foreach ($pair in @(@('cmd-unc', $UncFile), @('cmd-mapped', $MappedFile))) {
        if (-not $pair[1]) { continue }
        # One /c string; PowerShell wraps it in quotes and cmd strips the outer pair -> type "<path>" >nul
        $r = Invoke-LabNative -FilePath 'cmd.exe' -Arguments @('/d', '/c', ('type "' + $pair[1] + '" >nul'))
        $txt = (($r.Output | Where-Object { $_ }) -join ' ').Trim()
        Record-Attempt ($Prefix + '.' + $pair[0]) ($r.ExitCode -eq 0) ('cmd exit=' + $r.ExitCode + ' stderr=' + $txt) $Expect
    }
    # Windows PowerShell child (what the agent's exec tool falls back to): exact error text + exit code
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    foreach ($pair in @(@('psexec-unc', $UncFile), @('psexec-mapped', $MappedFile))) {
        if (-not $pair[1]) { continue }
        $cmdText = '$ErrorActionPreference=''Stop''; Get-Content -LiteralPath ''' + $pair[1] + ''' | Out-Null'
        $r = Invoke-LabNative -FilePath $psExe -Arguments @('-NoProfile', '-NonInteractive', '-Command', $cmdText)
        $txt = ((@($r.Output | Where-Object { $_ }) -join ' ') -replace '\s+', ' ').Trim()
        if ($txt.Length -gt 400) { $txt = $txt.Substring(0, 400) + '...' }
        Record-Attempt ($Prefix + '.' + $pair[0]) ($r.ExitCode -eq 0) ('powershell exit=' + $r.ExitCode + ' text=' + $txt) $Expect
    }
    # node child
    if ($nodeExe) {
        foreach ($pair in @(@('node-unc', $UncFile), @('node-mapped', $MappedFile))) {
            if (-not $pair[1]) { continue }
            $r = Invoke-LabNative -FilePath $nodeExe -Arguments @($nodeProbe, $pair[1])
            $line = [string](($r.Output | Where-Object { $_ -match '^\{' }) | Select-Object -First 1)
            $ok = $false; $sig = 'node exit=' + $r.ExitCode + ' out=' + (($r.Output) -join ' ')
            if ($line) {
                $j = $line | ConvertFrom-Json
                if ($j.ok) { $ok = $true } else { $sig = 'code=' + $j.code + ' errno=' + $j.errno + ' syscall=' + $j.syscall + ' msg=' + $j.message }
            }
            Record-Attempt ($Prefix + '.' + $pair[0]) $ok $sig $Expect
        }
    } else {
        Add-LabCheck ($Prefix + '.node') 'SKIP' 'node.exe not on PATH'
    }
}

# ------------------------------------------------------------------------------------------------
Write-LabSection 'Share root listing (Access-Based Enumeration check)'
try {
    $names = @([System.IO.Directory]::GetDirectories($SharePath) | ForEach-Object { Split-Path -Leaf $_ })
    $seesX = $names -contains 'ClientX'
    Set-LabValue 'share_root_sees_clientx' $seesX
    Add-LabCheck 'share_root_listing' 'INFO' ('folders visible: ' + $names.Count + '; ClientX visible=' + $seesX + ' (labB not seeing ClientX means ABE is on)')
} catch {
    Add-LabCheck 'share_root_listing' 'FAIL' ('cannot list share root: ' + (Format-LabError $_))
    Write-Result; return
}

Write-LabSection ('Map ' + $DriveLetter + ': in this session (net use, not persistent)')
$createdMapping = $false
$mappedRoot = ''
$existing = Get-PSDrive -Name $DriveLetter -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    $root = ''
    if ($null -ne $existing.DisplayRoot) { $root = [string]$existing.DisplayRoot }
    if ($root.TrimEnd('\') -ieq $SharePath) { $mappedRoot = $DriveLetter + ':\'; Add-LabCheck 'net_use' 'INFO' ('reusing existing ' + $DriveLetter + ': -> ' + $root) }
    else { Add-LabCheck 'net_use' 'SKIP' ($DriveLetter + ': is already used for ' + $root + '; pass -DriveLetter') }
} else {
    $r = Invoke-LabNative -FilePath 'net.exe' -Arguments @('use', ($DriveLetter + ':'), $SharePath, '/persistent:no')
    if ($r.ExitCode -eq 0) { $createdMapping = $true; $mappedRoot = $DriveLetter + ':\'; Add-LabCheck 'net_use' 'PASS' ($DriveLetter + ': -> ' + $SharePath) }
    else { Add-LabCheck 'net_use' 'WARN' ('net use failed: ' + (($r.Output) -join ' ')) }
}

try {
    Write-LabSection 'ClientX'
    $mx = ''; if ($mappedRoot) { $mx = Join-Path $mappedRoot ('ClientX\' + $FileName) }
    Invoke-ReadMatrix -Prefix 'clientx' -UncFile ($SharePath + '\ClientX\' + $FileName) -MappedFile $mx -Expect $ExpectClientX

    Write-LabSection 'ClientY'
    $my = ''; if ($mappedRoot) { $my = Join-Path $mappedRoot ('ClientY\' + $FileName) }
    Invoke-ReadMatrix -Prefix 'clienty' -UncFile ($SharePath + '\ClientY\' + $FileName) -MappedFile $my -Expect 'Allow'

    Write-LabSection 'Redirected folder / OneDrive'
    $docs = [Environment]::GetFolderPath('MyDocuments')
    Set-LabValue 'documents_path_is_unc' ($docs.StartsWith('\\'))
    $od = [Environment]::GetEnvironmentVariable('OneDrive')
    Set-LabValue 'onedrive_env_present' ([bool]$od)
    Add-LabCheck 'documents_redirected' 'INFO' ('Documents UNC=' + $docs.StartsWith('\\') + '; %OneDrive% set=' + [bool]$od)
    if ($RedirectedDeniedPath) { Invoke-ReadMatrix -Prefix 'redirected' -UncFile $RedirectedDeniedPath -MappedFile '' -Expect 'Deny' }
    else { Add-LabCheck 'redirected_denied' 'INFO' 'skipped: no -RedirectedDeniedPath given (no redirected-folder case in this lab)' }
    if ($OneDriveDeniedPath) { Invoke-ReadMatrix -Prefix 'onedrive' -UncFile $OneDriveDeniedPath -MappedFile '' -Expect 'Deny' }
    else { Add-LabCheck 'onedrive_denied' 'INFO' 'skipped: no -OneDriveDeniedPath given (OneDrive not set up in this lab)' }

    if (-not $SkipTaskTest) {
        Write-LabSection 'Mapped drive inside Task Scheduler processes (this user only)'
        foreach ($kind in @('Interactive', 'S4U')) {
            $out = Join-Path $workDir ('task-' + $kind + '.txt')
            $cmdFile = Join-Path $workDir ('task-' + $kind + '.cmd')
            Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
            $cmdText = @(
                '@echo off',
                ('if exist ' + $DriveLetter + ':\ (echo MAPPED_VISIBLE) else (echo MAPPED_NOT_VISIBLE)'),
                ('type "' + $DriveLetter + ':\ClientY\' + $FileName + '" >nul 2>&1 && echo MAPPED_READ_OK || echo MAPPED_READ_FAIL'),
                ('type "' + $SharePath + '\ClientY\' + $FileName + '" >nul 2>&1 && echo UNC_CLIENTY_READ_OK || echo UNC_CLIENTY_READ_FAIL'),
                ('type "' + $SharePath + '\ClientY\' + $FileName + '" 2>&1 >nul'),
                'whoami',
                'echo DONE'
            ) -join "`r`n"
            [System.IO.File]::WriteAllText($cmdFile, $cmdText, [System.Text.Encoding]::ASCII)
            $name = $taskPrefix + '-' + $kind
            try {
                $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/d /c ""' + $cmdFile + '" > "' + $out + '" 2>&1"')
                $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType $kind -RunLevel Limited
                $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
                $null = Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Force
                Start-ScheduledTask -TaskName $name
                $sw = New-LabTimer
                while ($sw.Elapsed.TotalSeconds -lt 45) {
                    if ((Test-Path -LiteralPath $out) -and ((Get-Content -LiteralPath $out -Raw -ErrorAction SilentlyContinue) -match 'DONE')) { break }
                    Start-Sleep -Milliseconds 500
                }
                $info = Get-ScheduledTaskInfo -TaskName $name
                $text = ''
                if (Test-Path -LiteralPath $out) { $text = ((Get-Content -LiteralPath $out) -join ' | ') }
                Set-LabValue ('task.' + $kind) ('lastResult=0x' + ([int]$info.LastTaskResult).ToString('X8') + ' out=' + $text)
                Add-LabCheck ('task_' + $kind) 'INFO' ('lastResult=0x' + ([int]$info.LastTaskResult).ToString('X8') + ' out=' + $text)
            } catch {
                Set-LabValue ('task.' + $kind) ('could not register/run: ' + (Format-LabError $_))
                Add-LabCheck ('task_' + $kind) 'INFO' ('could not register/run: ' + (Format-LabError $_))
            } finally {
                try { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop } catch { $null = $_ }
            }
        }
    }
} finally {
    if ($createdMapping) { $null = Invoke-LabNative -FilePath 'net.exe' -Arguments @('use', ($DriveLetter + ':'), '/delete', '/y') }
}

Write-LabSection 'Can the guard detect every denial?'
$undetectable = @($denySignatures | Where-Object { -not (Test-Detectable $_) })
$distinct = @($denySignatures | ForEach-Object { ($_ -replace ' msg=.*$', '') -replace ' stderr=.*$', '' } | Sort-Object -Unique)
Set-LabValue 'deny_signature_kinds' ($distinct -join ' || ')
if ($denySignatures.Count -eq 0) { Add-LabCheck 'guard_detectable' 'INFO' 'no denials happened in this run (expected for labA)' }
elseif ($undetectable.Count -eq 0) { Add-LabCheck 'guard_detectable' 'PASS' ($denySignatures.Count.ToString() + ' denials, all map to win32 5 / 0x80070005 / UnauthorizedAccess / EPERM / EACCES / "Access is denied"') }
else { Add-LabCheck 'guard_detectable' 'WARN' ('unrecognised denial signatures: ' + ($undetectable -join ' || ')) }

if (-not $KeepFiles -and (Test-Path -LiteralPath $workDir)) { Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue }
Write-Result
