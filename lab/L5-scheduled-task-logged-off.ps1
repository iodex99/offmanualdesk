<#
.SYNOPSIS
    L5 - Can a gateway run as a per-user Scheduled Task while the user is logged off, with UNC access to the
    file share? Compares S4U ("Do not store password") with a stored-password task.

.DESCRIPTION
    Question (docs/LAB_VALIDATION.md L5): Can a gateway run as a per-user Scheduled Task while the user is logged
    off, with UNC access? Feeds ARCHITECTURE.md flow F4 step 6 and ADR-005.

    Everything here is run by labAdmin from an ELEVATED PowerShell (labA only has to log on once beforehand and
    then sign out).

      -Role Register  Copies common.ps1 + task-runner.ps1 to C:\OffManualLab\tasks (SYSTEM/Admins Full, Users RX),
                      creates C:\OffManualLab\tasks\out\<User> (only <User>, SYSTEM, Admins), writes a random
                      gateway token there (LAB SHORTCUT, see task-runner.ps1), records whether <User> holds
                      "Log on as a batch job" (SeBatchLogonRight) before/after, asks for <User>'s password with
                      Get-Credential (never echoed or stored by this script; Task Scheduler stores it), and registers
                      four on-demand tasks in Task Scheduler folder \OffManualLab\ :
                        L5-Probe-S4U-<User>     S4U principal ("Run whether user is logged on or not" + "Do not store password")
                        L5-Probe-Pwd-<User>     stored password ("Run whether user is logged on or not")
                        L5-Gateway-S4U-<User>   same, action starts an OpenClaw gateway on -Port
                        L5-Gateway-Pwd-<User>   same, stored password
      -Role Run       After <User> has SIGNED OUT (not just disconnected): runs each probe task, then each gateway
                      task in turn; waits for /healthz; records process owner/session; UNC reads of ClientX/ClientY
                      from inside the task; DPAPI CurrentUser inside the task; then ends the task and checks the
                      gateway process is gone.
      -Role Cleanup   Unregisters every \OffManualLab\L5-* task and deletes C:\OffManualLab\tasks\out\<User>.
                      Run it AFTER L6 (L6 reuses the L5 gateway tasks). -All also removes C:\OffManualLab\tasks.

    Docs:
      - S4U vs password, "Logon as Batch" requirement, who can run tasks:
        https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks
      - New-ScheduledTaskPrincipal -LogonType S4U: https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal
      - Register-ScheduledTask -User/-Password: https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/register-scheduledtask
      - OpenClaw itself: "Managed Gateway startup uses a Scheduled Task with the current user's S4U principal ...
        S4U does not provide Windows network credentials or access to encrypted files; installations that need
        those capabilities can retain an operator-configured Password task." https://docs.openclaw.ai/platforms/windows.md
      - Error 0x80070569 = 1385 ERROR_LOGON_TYPE_NOT_GRANTED (user lacks "Log on as a batch job").

    Prerequisites: L1 -Role Install done; share built (README); labA has logged on at least once (profile exists).
    For the DPAPI-in-task check: labA ran L10 -Phase Protect before signing out (optional).
    NOTE: if the share is on the same VM, an S4U result can differ from a real separate file server. Record which.

    Exact commands (labAdmin, elevated):
      ...\L5-scheduled-task-logged-off.ps1 -Role Register -User labA -SharePath \\<host>\Clients
      (sign labA out: in labA's session Start > user icon > Sign out; or as admin: logoff <sessionId>)
      ...\L5-scheduled-task-logged-off.ps1 -Role Run -User labA
      (after L6:) ...\L5-scheduled-task-logged-off.ps1 -Role Cleanup -User labA -All

    What to paste back: Register and Run outputs (or lab\results\L5-*.txt), then /lab-result L5.

    Pass criteria (measurable):
      - logged_off: <User> has no RDS session (quser) during Run.
      - Password variant: probe reads ClientX via UNC = OK; gateway task /readyz 200 (after doctor --fix) while logged off;
        UNC ClientX read from inside the gateway task = OK; gateway listener owned by <User>.
      - S4U variant: same fields RECORDED (expected per OpenClaw docs: no network credentials -> UNC fails).
      - dpapi_l10_blob recorded for both variants (S4U is expected to fail - would break DPAPI-held tokens).
      - Task end stops the gateway (no node.exe left on the port 15 s after Stop-ScheduledTask).
      L5 PASS = at least one variant has gateway up after logoff AND reads ClientX as <User>.

    Leaves behind (until -Role Cleanup): the four tasks in \OffManualLab\, C:\OffManualLab\tasks (scripts, out\<User>
    with gateway.token, JSON results), the stored password inside Task Scheduler, %LOCALAPPDATA%\OffManualLab\L5
    in <User>'s profile (delete with L1/L5 cleanup as that user or by hand), possibly a SeBatchLogonRight grant
    made by Task Scheduler (reported; revert in secpol.msc if it was added).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Register', 'Run', 'Cleanup')][string]$Role,
    [string]$User = 'labA',
    [string]$SharePath = '',
    [string]$InstallRoot = 'C:\OffManualLab\openclaw',
    [string]$TasksRoot = 'C:\OffManualLab\tasks',
    [int]$Port = 18800,
    [int]$ProbeTimeoutSec = 120,
    [int]$GatewayTimeoutSec = 180,
    [switch]$All
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
trap { Write-LabUnhandled $_; break }

$null = Start-LabTranscript -Id 'L5' -Suffix ($Role + '-' + $User)
$session = Write-SessionInfo
Assert-LabElevated -Why 'L5 (registering/running tasks for another user)'
Set-LabValue 'role' $Role
Set-LabValue 'target_user' $User
if (-not $SharePath) { $SharePath = '\\' + $env:COMPUTERNAME + '\Clients' }
$TaskPath = '\OffManualLab\'
$outDir = Join-Path $TasksRoot ('out\' + $User)
$userSid = Resolve-LabAccountSid -Account $User
$userFull = (New-Object System.Security.Principal.SecurityIdentifier($userSid)).Translate([System.Security.Principal.NTAccount]).Value
Set-LabValue 'target_sid' $userSid

function Get-BatchRightHolders {
    $tmp = Join-Path $env:TEMP ('secedit-' + [guid]::NewGuid().ToString('N') + '.inf')
    try {
        $r = Invoke-LabNative -FilePath 'secedit.exe' -Arguments @('/export', '/areas', 'USER_RIGHTS', '/cfg', $tmp, '/quiet')
        if (-not (Test-Path -LiteralPath $tmp)) { return 'secedit failed: ' + ($r.Output -join ' ') }
        $line = @(Get-Content -LiteralPath $tmp | Where-Object { $_ -match '^SeBatchLogonRight\s*=' })
        if ($line.Count -eq 0) { return '' }
        return ($line[0] -replace '^SeBatchLogonRight\s*=\s*', '').Trim()
    } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}

function Test-BatchRight {
    param([string]$Holders)
    $userGroups = @('*' + $userSid, '*S-1-5-32-545', '*S-1-1-0', '*S-1-5-11')
    foreach ($h in ($Holders -split ',')) { if ($userGroups -contains $h.Trim()) { return $true } }
    return $false
}

function Get-TaskNames {
    return @(
        @{ Name = ('L5-Probe-S4U-' + $User); Mode = 'Probe'; Kind = 'S4U' },
        @{ Name = ('L5-Probe-Pwd-' + $User); Mode = 'Probe'; Kind = 'Pwd' },
        @{ Name = ('L5-Gateway-S4U-' + $User); Mode = 'Gateway'; Kind = 'S4U' },
        @{ Name = ('L5-Gateway-Pwd-' + $User); Mode = 'Gateway'; Kind = 'Pwd' }
    )
}

function Wait-TaskNotRunning {
    param([string]$Name, [int]$TimeoutSec)
    $sw = New-LabTimer
    Start-Sleep -Milliseconds 500
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        $t = Get-ScheduledTask -TaskPath $TaskPath -TaskName $Name
        if ($t.State -ne 'Running') { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-ListenerOwner {
    param([int]$ListenPort)
    $l = @(Get-NetTCPConnection -State Listen -LocalPort $ListenPort -ErrorAction SilentlyContinue)
    if ($l.Count -eq 0) { return $null }
    $procId = [int]$l[0].OwningProcess
    $cim = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $procId)
    $owner = Invoke-CimMethod -InputObject $cim -MethodName GetOwner
    return [pscustomobject]@{ Pid = $procId; Owner = ([string]$owner.Domain + '\' + [string]$owner.User); SessionId = [int]$cim.SessionId; Name = [string]$cim.Name }
}

# ------------------------------------------------------------------------------------------------
if ($Role -eq 'Cleanup') {
    foreach ($t in (Get-TaskNames)) {
        try { Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name -Confirm:$false -ErrorAction Stop; Add-LabCheck ('unregister_' + $t.Name) 'PASS' 'removed' }
        catch { Add-LabCheck ('unregister_' + $t.Name) 'INFO' 'not present' }
    }
    if (Test-Path -LiteralPath $outDir) { Remove-Item -LiteralPath $outDir -Recurse -Force; Add-LabCheck 'remove_out' 'PASS' $outDir }
    if ($All -and (Test-Path -LiteralPath $TasksRoot)) { Remove-Item -LiteralPath $TasksRoot -Recurse -Force; Add-LabCheck 'remove_tasks_root' 'PASS' $TasksRoot }
    try {
        $svc = New-Object -ComObject Schedule.Service
        $svc.Connect()
        $folder = $svc.GetFolder('\OffManualLab')
        if ($folder.GetTasks(1).Count -eq 0) { $svc.GetFolder('\').DeleteFolder('OffManualLab', 0); Add-LabCheck 'remove_task_folder' 'PASS' '\OffManualLab' }
    } catch { $null = $_ }
    Add-LabCheck 'batch_right_note' 'INFO' ('SeBatchLogonRight holders now: ' + (Get-BatchRightHolders) + ' - remove ' + $User + ' in secpol.msc if L5 Register reported it was added')
    Add-LabCheck 'profile_state_note' 'INFO' ('delete %LOCALAPPDATA%\OffManualLab\L5 in ' + $User + '''s profile (sign in as ' + $User + ' and run L1 -Role Cleanup, or delete by hand)')
    Write-Result
    return
}

# ------------------------------------------------------------------------------------------------
if ($Role -eq 'Register') {
    Write-LabSection 'Copy runner scripts to a location every context can read'
    foreach ($d in @($TasksRoot, $outDir)) { if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'common.ps1') -Destination $TasksRoot -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'task-runner.ps1') -Destination $TasksRoot -Force
    $r1 = Invoke-LabNative -FilePath 'icacls.exe' -Arguments @($TasksRoot, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-32-545:(OI)(CI)RX', '/C', '/Q')
    $r2 = Invoke-LabNative -FilePath 'icacls.exe' -Arguments @($outDir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', ('*' + $userSid + ':(OI)(CI)M'), '/C', '/Q')
    if ($r1.ExitCode -eq 0 -and $r2.ExitCode -eq 0) { Add-LabCheck 'acls' 'PASS' ($TasksRoot + ' Users RX; ' + $outDir + ' ' + $User + ' Modify only') }
    else { Add-LabCheck 'acls' 'FAIL' (($r1.Output + $r2.Output) -join ' ') }

    $token = New-LabSecret
    Write-LabTextFile -Path (Join-Path $outDir 'gateway.token') -Text $token
    Set-LabValue 'gateway_token_hash' (Get-LabHashPrefix $token)
    Add-LabCheck 'gateway_token_file' 'INFO' ('LAB SHORTCUT: token in ' + $outDir + '\gateway.token (ACL ' + $User + '/SYSTEM/Admins); hash ' + (Get-LabHashPrefix $token))

    Write-LabSection 'Log on as a batch job (SeBatchLogonRight) - before'
    $before = Get-BatchRightHolders
    Set-LabValue 'batch_right_before' $before
    Set-LabValue 'user_has_batch_right_before' (Test-BatchRight $before)
    Write-LabInfo ('holders: ' + $before)

    Write-LabSection ('Password for ' + $userFull + ' (stored by Task Scheduler only)')
    $cred = Get-Credential -UserName $userFull -Message ('Password of ' + $userFull + ' for the L5 stored-password tasks (not saved by the script)')
    if ($null -eq $cred) { Add-LabCheck 'credential' 'FAIL' 'no credential entered'; Write-Result; return }

    $runner = Join-Path $TasksRoot 'task-runner.ps1'
    $settingsProbe = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
    $settingsGw = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    foreach ($t in (Get-TaskNames)) {
        $taskArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $runner + '" -Mode ' + $t.Mode +
                ' -Label ' + $t.Kind + ' -OutDir "' + $outDir + '" -SharePath "' + $SharePath + '" -InstallRoot "' + $InstallRoot + '" -Port ' + $Port
        $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument $taskArgs -WorkingDirectory $TasksRoot
        $settings = $settingsProbe
        if ($t.Mode -eq 'Gateway') { $settings = $settingsGw }
        try {
            if ($t.Kind -eq 'S4U') {
                $principal = New-ScheduledTaskPrincipal -UserId $userFull -LogonType S4U -RunLevel Limited
                $null = Register-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name -Action $action -Settings $settings -Principal $principal -Force
            } else {
                $null = Register-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name -Action $action -Settings $settings -User $userFull -Password ($cred.GetNetworkCredential().Password) -RunLevel Limited -Force
            }
            $reg = Get-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name
            Add-LabCheck ('register_' + $t.Name) 'PASS' ('LogonType=' + $reg.Principal.LogonType + ' UserId=' + $reg.Principal.UserId)
        } catch {
            Add-LabCheck ('register_' + $t.Name) 'FAIL' (Format-LabError $_)
        }
    }
    $cred = $null

    Write-LabSection 'Log on as a batch job - after registering'
    $after = Get-BatchRightHolders
    Set-LabValue 'batch_right_after' $after
    Set-LabValue 'user_has_batch_right_after' (Test-BatchRight $after)
    if ($after -ne $before) { Add-LabCheck 'batch_right_changed' 'INFO' ('Task Scheduler changed SeBatchLogonRight: ' + $after) }
    else { Add-LabCheck 'batch_right_changed' 'INFO' ('unchanged; ' + $User + ' covered=' + (Test-BatchRight $after)) }

    Write-Host ''
    Write-Host ('>>> Now SIGN OUT ' + $User + ' completely (Start > ' + $User + ' > Sign out, or as admin: logoff <id>).')
    Write-Host ('>>> Then run: ...\L5-scheduled-task-logged-off.ps1 -Role Run -User ' + $User)
    Write-Result
    return
}

# ------------------------------------------------------------------------------------------------
# Role Run
Write-LabSection ('Is ' + $User + ' logged off?')
$sess = @(Get-LabUserSessions | Where-Object { $_.UserName -ieq $User })
if ($sess.Count -eq 0) { Add-LabCheck 'logged_off' 'PASS' ('no session for ' + $User) }
else { Add-LabCheck 'logged_off' 'WARN' ($User + ' still has session(s): ' + (@($sess | ForEach-Object { [string]$_.SessionId + ':' + $_.State }) -join ', ') + ' - sign out (not disconnect) and re-run') }
Set-LabValue 'user_sessions' (@($sess | ForEach-Object { [string]$_.SessionId + ':' + $_.State }) -join ',')

$variantOk = @{}
foreach ($t in (Get-TaskNames)) {
    Write-LabSection $t.Name
    $task = $null
    try { $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name -ErrorAction Stop } catch { Add-LabCheck ('task_' + $t.Name) 'FAIL' 'not registered (run -Role Register)'; continue }
    $jsonName = 'probe-' + $t.Kind + '.json'
    if ($t.Mode -eq 'Gateway') { $jsonName = 'gateway-' + $t.Kind + '.json' }
    $jsonPath = Join-Path $outDir $jsonName
    Remove-Item -LiteralPath $jsonPath -Force -ErrorAction SilentlyContinue

    if ($t.Mode -eq 'Gateway' -and (Test-LabTcpPort -Port $Port)) {
        Add-LabCheck ('port_free_' + $t.Name) 'FAIL' ('port ' + $Port + ' already in use; stop the other gateway first')
        continue
    }
    $sw = New-LabTimer
    Start-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name

    if ($t.Mode -eq 'Probe') {
        $done = Wait-TaskNotRunning -Name $t.Name -TimeoutSec $ProbeTimeoutSec
        $info = Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $t.Name
        $lr = '0x' + ([int]$info.LastTaskResult).ToString('X8')
        Set-LabValue ($t.Name + '.last_result') $lr
        if (Test-Path -LiteralPath $jsonPath) {
            $j = Get-Content -LiteralPath $jsonPath -Raw | ConvertFrom-Json
            foreach ($p in $j.PSObject.Properties) { Set-LabValue ($t.Name + '.' + $p.Name) $p.Value }
            $x = [string]$j.unc_ClientX
            Add-LabCheck ('probe_' + $t.Kind) 'INFO' ('user=' + $j.user + ' session=' + $j.session_id + ' batch=' + $j.group_batch + ' profile_loaded=' + $j.profile_loaded + ' ClientX=' + $x + ' ClientY=' + $j.unc_ClientY + ' dpapi_roundtrip=' + $j.dpapi_roundtrip + ' dpapi_l10_blob=' + $j.dpapi_l10_blob)
        } else {
            $hint = ''
            if ($lr -eq '0x80070569') { $hint = ' (1385 ERROR_LOGON_TYPE_NOT_GRANTED: give ' + $User + ' "Log on as a batch job" in secpol.msc > Local Policies > User Rights Assignment, then re-run)' }
            Add-LabCheck ('probe_' + $t.Kind) 'WARN' ('no output; task finished=' + $done + ' lastResult=' + $lr + $hint)
        }
        continue
    }

    # Gateway task
    # Timer includes the runner's "doctor --fix" step that precedes "gateway run".
    $healthMs = Wait-LabHttpOk -Uri ('http://127.0.0.1:' + $Port + '/healthz') -TimeoutSec $GatewayTimeoutSec -Timer $sw
    $readyMs = -1
    if ($healthMs -ge 0) { $readyMs = Wait-LabHttpOk -Uri ('http://127.0.0.1:' + $Port + '/readyz') -TimeoutSec 90 -Timer $sw }
    Set-LabValue ($t.Name + '.health_ms_from_start') $healthMs
    Set-LabValue ($t.Name + '.ready_ms_from_start') $readyMs
    $owner = Get-ListenerOwner -ListenPort $Port
    if ($null -ne $owner) {
        Set-LabValue ($t.Name + '.listener') ($owner.Name + ' pid ' + $owner.Pid + ' owner ' + $owner.Owner + ' session ' + $owner.SessionId)
    }
    Start-Sleep -Seconds 3
    $j = $null
    if (Test-Path -LiteralPath $jsonPath) {
        $j = Get-Content -LiteralPath $jsonPath -Raw | ConvertFrom-Json
        foreach ($p in $j.PSObject.Properties) { Set-LabValue ($t.Name + '.' + $p.Name) $p.Value }
    }
    $ownerOk = ($null -ne $owner -and $owner.Owner -ieq $userFull)
    $uncX = ''
    if ($null -ne $j -and $null -ne $j.PSObject.Properties['unc_ClientX']) { $uncX = [string]$j.unc_ClientX }
    $ownerDesc = '?'
    if ($null -ne $owner) { $ownerDesc = $owner.Owner + ' session ' + $owner.SessionId }
    if ($readyMs -ge 0) {
        Add-LabCheck ('gateway_up_' + $t.Kind) 'PASS' ('/healthz ' + $healthMs + ' ms, /readyz ' + $readyMs + ' ms after Start-ScheduledTask; listener owner ' + $ownerDesc)
    } elseif ($healthMs -ge 0) {
        Add-LabCheck ('gateway_up_' + $t.Kind) 'WARN' ('live (/healthz ' + $healthMs + ' ms) but /readyz not 200 within 90 s; listener owner ' + $ownerDesc)
    } else {
        $info = Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $t.Name
        Add-LabCheck ('gateway_up_' + $t.Kind) 'WARN' ('no /healthz within ' + $GatewayTimeoutSec + ' s; lastResult=0x' + ([int]$info.LastTaskResult).ToString('X8'))
        $runnerLog = Join-Path $outDir ('runner-Gateway-' + $t.Kind + '.log')
        foreach ($l in (Get-LabFileTail -Path $runnerLog -Lines 10)) { Write-LabInfo ('runner| ' + $l) }
        if ($null -ne $j -and $null -ne $j.PSObject.Properties['log_tail']) { Write-LabInfo ('gateway stderr| ' + $j.log_tail) }
    }
    Add-LabCheck ('gateway_unc_clientx_' + $t.Kind) 'INFO' ('ClientX from inside the gateway task: ' + $uncX)
    $variantOk[$t.Kind] = (($readyMs -ge 0) -and $ownerOk -and ($uncX -eq 'OK'))

    Write-LabSection ('Stop ' + $t.Name)
    Stop-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name
    $gone = $false
    $sw2 = New-LabTimer
    while ($sw2.Elapsed.TotalSeconds -lt 15) { if (-not (Test-LabTcpPort -Port $Port -TimeoutMs 300)) { $gone = $true; break }; Start-Sleep -Milliseconds 500 }
    if ($gone) { Add-LabCheck ('stop_kills_gateway_' + $t.Kind) 'PASS' ('port closed ' + $sw2.ElapsedMilliseconds + ' ms after Stop-ScheduledTask') }
    else {
        Add-LabCheck ('stop_kills_gateway_' + $t.Kind) 'WARN' 'gateway still listening 15 s after Stop-ScheduledTask (task end does not kill the node child); killing it'
        $o = Get-ListenerOwner -ListenPort $Port
        if ($null -ne $o) { Stop-LabProcessTree -RootPid $o.Pid }
    }
}

Write-LabSection 'Summary'
foreach ($k in @('Pwd', 'S4U')) {
    $v = $false
    if ($variantOk.ContainsKey($k)) { $v = $variantOk[$k] }
    Set-LabValue ('variant_' + $k + '_gateway_up_and_reads_clientx') $v
}
$anyOk = ($variantOk.ContainsKey('Pwd') -and $variantOk['Pwd']) -or ($variantOk.ContainsKey('S4U') -and $variantOk['S4U'])
if ($anyOk) { Add-LabCheck 'l5_goal' 'PASS' 'a logged-off gateway task came up as the user and read ClientX via UNC' }
else { Add-LabCheck 'l5_goal' 'FAIL' 'no variant had gateway up + owner = user + ClientX readable' }
Write-Result
