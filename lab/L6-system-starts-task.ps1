<#
.SYNOPSIS
    L6 - Can a SYSTEM process (stand-in for the Server Agent service) start labA's gateway task on demand, and how
    long from trigger to the gateway answering /healthz and /readyz?

.DESCRIPTION
    Question (docs/LAB_VALIDATION.md L6): Can the SYSTEM service start that task on demand, and how fast to ready?
    Feeds ADR-005 (Telegram wake-on-message) and ARCHITECTURE.md flow F4 step 6 / F7 step 3.

    Depends on L5: uses the task \OffManualLab\L5-Gateway-<Variant>-<User> registered by L5 -Role Register.

    Roles:
      -Role Launcher     labAdmin, ELEVATED PowerShell. Copies this script next to common.ps1 in
                         C:\OffManualLab\tasks, then runs it AS SYSTEM with -Role SystemProbe, either via a one-off
                         Task Scheduler task "\OffManualLab\L6-SystemProbe" running as NT AUTHORITY\SYSTEM (default),
                         or via Sysinternals "psexec -s" if you pass -UsePsExec (psexec.exe must be on PATH).
                         Waits, prints the SYSTEM transcript, deletes the one-off task.
      -Role SystemProbe  Runs as SYSTEM (refuses otherwise). For each of -Runs runs: makes sure the gateway is down,
                         triggers the labA task with -Method Com (Task Scheduler COM API IRegisteredTask.Run) or
                         -Method Schtasks (schtasks /run /tn ...), and measures ms from trigger to: task state
                         Running, TCP port open, /healthz 200, /readyz 200. Records the listener's owner and session,
                         whether labA was logged on/off (quser), then ends the task (IRegisteredTask.Stop) and checks
                         the gateway is gone. The first run is the "cold" number (reboot the VM before L6 for a true
                         cold start).
      -Role Cleanup      Removes \OffManualLab\L6-SystemProbe if left behind and C:\OffManualLab\tasks\L6-*.ps1.

    Docs:
      - SYSTEM can run any task: "Members of the Administrators group or the SYSTEM account can read, update,
        delete, and run any tasks." https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks
      - IRegisteredTask::Run / Stop: https://learn.microsoft.com/en-us/windows/win32/api/taskschd/nf-taskschd-iregisteredtask-run
        https://learn.microsoft.com/en-us/windows/win32/api/taskschd/nf-taskschd-iregisteredtask-stop
      - schtasks /run: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-run
      - PsExec -s: https://learn.microsoft.com/en-us/sysinternals/downloads/psexec
      - OpenClaw /healthz (live) and /readyz (ready): https://docs.openclaw.ai/gateway/health.md

    Prerequisites: L5 -Role Register done (gateway tasks exist); ideally labA signed out (run once logged off and
    once with labA logged on to compare); port -Port free.

    Exact commands (labAdmin, elevated):
      ...\L6-system-starts-task.ps1 -Role Launcher -User labA -Variant Pwd
      ...\L6-system-starts-task.ps1 -Role Launcher -User labA -Variant S4U
      ...\L6-system-starts-task.ps1 -Role Launcher -User labA -Variant Pwd -Method Schtasks
      (optional, psexec on PATH) ...\L6-system-starts-task.ps1 -Role Launcher -User labA -UsePsExec
      ...\L6-system-starts-task.ps1 -Role Cleanup

    What to paste back: the Launcher output (it includes the SYSTEM transcript), then /lab-result L6.

    Pass criteria (measurable):
      - runs_as_system: SystemProbe identity is S-1-5-18.
      - trigger_ok: Run() / schtasks /run from SYSTEM returns without error on every run.
      - ready: /readyz 200 on every run within -TimeoutSec (default 180 s) + 60 s; listener owner = <User>.
      - Times recorded: trigger->running, trigger->port open, trigger->healthz, trigger->readyz (ms) per run,
        cold (run 1) and warm (median of the rest). These include the task runner's "doctor --fix --yes
        --non-interactive" step (docs/OPENCLAW_NOTES.md section 8), which the product also runs before start.
      L6 PASS = all runs reach /readyz with owner = <User>.

    Leaves behind: C:\OffManualLab\tasks\L6-system-starts-task.ps1 and results under C:\OffManualLab\tasks\results
    (removed with L5 -Role Cleanup -All or L6 -Role Cleanup). The one-off SYSTEM task is deleted by the Launcher.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Launcher', 'SystemProbe', 'Cleanup')][string]$Role,
    [string]$User = 'labA',
    [ValidateSet('Pwd', 'S4U')][string]$Variant = 'Pwd',
    [ValidateSet('Com', 'Schtasks')][string]$Method = 'Com',
    [int]$Port = 18800,
    [int]$Runs = 3,
    [int]$TimeoutSec = 180,
    [string]$TasksRoot = 'C:\OffManualLab\tasks',
    [switch]$UsePsExec
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
trap { Write-LabUnhandled $_; break }

$targetTask = 'L5-Gateway-' + $Variant + '-' + $User
$probeTaskName = 'L6-SystemProbe'
$scriptName = Split-Path -Leaf $PSCommandPath

# ------------------------------------------------------------------------------------------------
if ($Role -eq 'Cleanup') {
    $null = Start-LabTranscript -Id 'L6' -Suffix 'Cleanup'
    $null = Write-SessionInfo
    Assert-LabElevated -Why 'L6 cleanup'
    try { Unregister-ScheduledTask -TaskPath '\OffManualLab\' -TaskName $probeTaskName -Confirm:$false -ErrorAction Stop; Add-LabCheck 'remove_probe_task' 'PASS' 'removed' } catch { Add-LabCheck 'remove_probe_task' 'INFO' 'not present' }
    $copy = Join-Path $TasksRoot $scriptName
    if (Test-Path -LiteralPath $copy) { Remove-Item -LiteralPath $copy -Force; Add-LabCheck 'remove_copy' 'PASS' $copy }
    Write-Result
    return
}

# ------------------------------------------------------------------------------------------------
if ($Role -eq 'Launcher') {
    $null = Start-LabTranscript -Id 'L6' -Suffix ('Launcher-' + $Variant + '-' + $Method)
    $null = Write-SessionInfo
    Assert-LabElevated -Why 'launching a SYSTEM process'
    Set-LabValue 'variant' $Variant
    Set-LabValue 'method' $Method
    if (-not (Test-Path -LiteralPath (Join-Path $TasksRoot 'common.ps1'))) { Add-LabCheck 'l5_registered' 'FAIL' ($TasksRoot + '\common.ps1 missing; run L5 -Role Register first'); Write-Result; return }
    try { $null = Get-ScheduledTask -TaskPath '\OffManualLab\' -TaskName $targetTask -ErrorAction Stop; Add-LabCheck 'l5_registered' 'PASS' ('\OffManualLab\' + $targetTask) }
    catch { Add-LabCheck 'l5_registered' 'FAIL' ('\OffManualLab\' + $targetTask + ' not found; run L5 -Role Register'); Write-Result; return }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'common.ps1') -Destination $TasksRoot -Force
    Copy-Item -LiteralPath $PSCommandPath -Destination $TasksRoot -Force
    $copy = Join-Path $TasksRoot $scriptName
    $resultsDir = Join-Path $TasksRoot 'results'
    $before = @()
    if (Test-Path -LiteralPath $resultsDir) { $before = @(Get-ChildItem -LiteralPath $resultsDir -Filter 'L6-*SystemProbe*' | ForEach-Object { $_.FullName }) }
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $probeArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $copy + '" -Role SystemProbe -User ' + $User + ' -Variant ' + $Variant +
                 ' -Method ' + $Method + ' -Port ' + $Port + ' -Runs ' + $Runs + ' -TimeoutSec ' + $TimeoutSec

    $limitSec = ($Runs * ($TimeoutSec + 60)) + 120
    if ($UsePsExec) {
        $psexec = Get-Command psexec.exe -ErrorAction SilentlyContinue
        if ($null -eq $psexec) { $psexec = Get-Command psexec64.exe -ErrorAction SilentlyContinue }
        if ($null -eq $psexec) { Add-LabCheck 'psexec' 'FAIL' 'psexec.exe not on PATH (download Sysinternals PsTools)'; Write-Result; return }
        Write-LabInfo ('psexec -accepteula -nobanner -s ' + $ps + ' ' + $probeArgs)
        $r = Invoke-LabNative -FilePath $psexec.Source -Arguments (@('-accepteula', '-nobanner', '-s', $ps) + ($probeArgs -split ' (?=(?:[^"]*"[^"]*")*[^"]*$)'))
        Add-LabCheck 'launch' 'INFO' ('psexec exit ' + $r.ExitCode)
    } else {
        $action = New-ScheduledTaskAction -Execute $ps -Argument $probeArgs -WorkingDirectory $TasksRoot
        $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds $limitSec)
        $null = Register-ScheduledTask -TaskPath '\OffManualLab\' -TaskName $probeTaskName -Action $action -Principal $principal -Settings $settings -Force
        try {
            Start-ScheduledTask -TaskPath '\OffManualLab\' -TaskName $probeTaskName
            Write-LabInfo ('SYSTEM probe running (up to ' + $limitSec + ' s)...')
            $sw = New-LabTimer
            Start-Sleep -Seconds 2
            while ($sw.Elapsed.TotalSeconds -lt $limitSec) {
                if ((Get-ScheduledTask -TaskPath '\OffManualLab\' -TaskName $probeTaskName).State -ne 'Running') { break }
                Start-Sleep -Seconds 1
            }
            $info = Get-ScheduledTaskInfo -TaskPath '\OffManualLab\' -TaskName $probeTaskName
            Add-LabCheck 'launch' 'INFO' ('SYSTEM task lastResult=0x' + ([int]$info.LastTaskResult).ToString('X8'))
        } finally {
            Unregister-ScheduledTask -TaskPath '\OffManualLab\' -TaskName $probeTaskName -Confirm:$false
        }
    }
    $after = @()
    if (Test-Path -LiteralPath $resultsDir) { $after = @(Get-ChildItem -LiteralPath $resultsDir -Filter 'L6-*SystemProbe*' | Sort-Object LastWriteTime | ForEach-Object { $_.FullName }) }
    $new = @($after | Where-Object { $before -notcontains $_ })
    if ($new.Count -eq 0) { Add-LabCheck 'system_transcript' 'FAIL' ('no SystemProbe transcript in ' + $resultsDir) }
    else {
        Add-LabCheck 'system_transcript' 'PASS' $new[-1]
        Write-LabSection 'SYSTEM transcript (verbatim)'
        foreach ($l in (Get-Content -LiteralPath $new[-1])) { Write-Host ('  S| ' + $l) }
        $res = @(Get-Content -LiteralPath $new[-1] | Where-Object { $_ -match '^RESULT L6' })
        if ($res.Count -gt 0) { Set-LabValue 'system_probe_result' $res[-1] }
    }
    Write-Result -Reasons @('The SYSTEM probe''s own RESULT line (above, prefixed S|) carries the L6 verdict.')
    return
}

# ------------------------------------------------------------------------------------------------
# SystemProbe (runs as SYSTEM)
$null = Start-LabTranscript -Id 'L6' -Suffix ('SystemProbe-' + $Variant + '-' + $Method)
$s = Write-SessionInfo
if ($s.IsSystem) { Add-LabCheck 'runs_as_system' 'PASS' $s.Sid } else { Add-LabCheck 'runs_as_system' 'FAIL' ('running as ' + $s.User); Write-Result; return }
Set-LabValue 'variant' $Variant
Set-LabValue 'method' $Method
Set-LabValue 'target_task' ('\OffManualLab\' + $targetTask)
$userSid = Resolve-LabAccountSid -Account $User
$userFull = (New-Object System.Security.Principal.SecurityIdentifier($userSid)).Translate([System.Security.Principal.NTAccount]).Value
$sess = @(Get-LabUserSessions | Where-Object { $_.UserName -ieq $User })
$userState = 'logged_off'
if ($sess.Count -gt 0) { $userState = 'logged_on(' + (@($sess | ForEach-Object { [string]$_.SessionId + ':' + $_.State }) -join ',') + ')' }
Set-LabValue 'user_state' $userState
Add-LabCheck 'user_state' 'INFO' ($User + ' is ' + $userState)

$svc = New-Object -ComObject Schedule.Service
$svc.Connect()
$folder = $svc.GetFolder('\OffManualLab')
$task = $folder.GetTask($targetTask)

function Get-TaskStateName { param([int]$State) switch ($State) { 0 { 'Unknown' } 1 { 'Disabled' } 2 { 'Queued' } 3 { 'Ready' } 4 { 'Running' } default { [string]$State } } }

$healthTimes = New-Object System.Collections.ArrayList
$readyTimes = New-Object System.Collections.ArrayList
$allOk = $true
for ($run = 1; $run -le $Runs; $run++) {
    Write-LabSection ('Run ' + $run + ' of ' + $Runs)
    if ($task.State -eq 4) { $task.Stop(0); Start-Sleep -Seconds 3 }
    if (Test-LabTcpPort -Port $Port -TimeoutMs 300) {
        Add-LabCheck ('run' + $run + '_port_free') 'FAIL' ('port ' + $Port + ' busy before trigger')
        $allOk = $false; continue
    }
    $sw = New-LabTimer
    $trigErr = ''
    try {
        if ($Method -eq 'Com') { $null = $task.Run($null) }
        else {
            $r = Invoke-LabNative -FilePath 'schtasks.exe' -Arguments @('/run', '/tn', ('\OffManualLab\' + $targetTask))
            if ($r.ExitCode -ne 0) { $trigErr = 'schtasks exit ' + $r.ExitCode + ': ' + ($r.Output -join ' ') }
        }
    } catch { $trigErr = Format-LabError $_ }
    $trigMs = [int]$sw.ElapsedMilliseconds
    if ($trigErr) { Add-LabCheck ('run' + $run + '_trigger') 'FAIL' $trigErr; $allOk = $false; continue }
    Add-LabCheck ('run' + $run + '_trigger') 'PASS' ('returned after ' + $trigMs + ' ms')

    $runningMs = -1; $portMs = -1; $healthMs = -1; $readyMs = -1
    $deadline = $TimeoutSec * 1000
    while ($sw.ElapsedMilliseconds -lt $deadline) {
        if ($runningMs -lt 0) { $t2 = $folder.GetTask($targetTask); if ($t2.State -eq 4) { $runningMs = [int]$sw.ElapsedMilliseconds } }
        if ($portMs -lt 0 -and (Test-LabTcpPort -Port $Port -TimeoutMs 200)) { $portMs = [int]$sw.ElapsedMilliseconds }
        if ($portMs -ge 0 -and $healthMs -lt 0) { $h = Invoke-LabHttp -Uri ('http://127.0.0.1:' + $Port + '/healthz') -TimeoutSec 2; if ($h.StatusCode -eq 200) { $healthMs = [int]$sw.ElapsedMilliseconds } }
        if ($healthMs -ge 0) { $rd = Invoke-LabHttp -Uri ('http://127.0.0.1:' + $Port + '/readyz') -TimeoutSec 2; if ($rd.StatusCode -eq 200) { $readyMs = [int]$sw.ElapsedMilliseconds; break } }
        if ($healthMs -ge 0 -and ($sw.ElapsedMilliseconds - $healthMs) -gt 60000) { break }
        Start-Sleep -Milliseconds 200
    }
    $ownerText = ''
    $l = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($l.Count -gt 0) {
        $cim = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + [int]$l[0].OwningProcess)
        $o = Invoke-CimMethod -InputObject $cim -MethodName GetOwner
        $ownerText = [string]$o.Domain + '\' + [string]$o.User + ' session ' + $cim.SessionId
    }
    $t3 = $folder.GetTask($targetTask)
    Set-LabValue ('run' + $run + '.trigger_ms') $trigMs
    Set-LabValue ('run' + $run + '.running_ms') $runningMs
    Set-LabValue ('run' + $run + '.port_open_ms') $portMs
    Set-LabValue ('run' + $run + '.healthz_ms') $healthMs
    Set-LabValue ('run' + $run + '.readyz_ms') $readyMs
    Set-LabValue ('run' + $run + '.listener_owner') $ownerText
    Set-LabValue ('run' + $run + '.task_state') (Get-TaskStateName $t3.State)
    $ownerOk = $ownerText -like ($userFull + ' *')
    if ($readyMs -ge 0 -and $ownerOk) {
        Add-LabCheck ('run' + $run + '_ready') 'PASS' ('running ' + $runningMs + ' ms, port ' + $portMs + ' ms, healthz ' + $healthMs + ' ms, readyz ' + $readyMs + ' ms; owner ' + $ownerText)
        $null = $healthTimes.Add($healthMs)
        if ($readyMs -ge 0) { $null = $readyTimes.Add($readyMs) }
    } else {
        Add-LabCheck ('run' + $run + '_ready') 'FAIL' ('healthz ' + $healthMs + ' ms; owner "' + $ownerText + '"; task state ' + (Get-TaskStateName $t3.State) + ' lastResult 0x' + ([int]$t3.LastTaskResult).ToString('X8'))
        $allOk = $false
    }

    $t3.Stop(0)
    $gone = $false
    $sw2 = New-LabTimer
    while ($sw2.Elapsed.TotalSeconds -lt 15) { if (-not (Test-LabTcpPort -Port $Port -TimeoutMs 200)) { $gone = $true; break }; Start-Sleep -Milliseconds 300 }
    if (-not $gone) {
        Add-LabCheck ('run' + $run + '_stop') 'WARN' 'gateway still listening 15 s after IRegisteredTask.Stop; killing the listener tree'
        $l = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
        if ($l.Count -gt 0) { Stop-LabProcessTree -RootPid ([int]$l[0].OwningProcess) }
    } else {
        Add-LabCheck ('run' + $run + '_stop') 'PASS' ('port closed ' + $sw2.ElapsedMilliseconds + ' ms after Stop')
    }
    Start-Sleep -Seconds 5
}

if ($healthTimes.Count -gt 0) {
    Set-LabValue 'cold_healthz_ms' $healthTimes[0]
    if ($healthTimes.Count -gt 1) {
        $warm = @($healthTimes | Select-Object -Skip 1 | Sort-Object)
        Set-LabValue 'warm_healthz_ms_median' $warm[[int][math]::Floor(($warm.Count - 1) / 2)]
    }
}
if ($readyTimes.Count -gt 0) { Set-LabValue 'cold_readyz_ms' $readyTimes[0] }
Write-Result
