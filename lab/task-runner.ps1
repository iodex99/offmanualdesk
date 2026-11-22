<#
.SYNOPSIS
    Helper run BY the L5/L6 scheduled tasks (not by hand). L5 -Role Register copies it, with common.ps1, to
    C:\OffManualLab\tasks\ and registers tasks that start it as labA.

.DESCRIPTION
    -Mode Probe    Records who/what the task process is (user, SID, session, BATCH/INTERACTIVE groups, profile
                   and %LOCALAPPDATA%), tries to read \\<host>\Clients\ClientX\test.txt and ClientY via UNC,
                   tries DPAPI CurrentUser (fresh round-trip, and decrypting the blob L10 -Phase Protect left in
                   %LOCALAPPDATA%\OffManualLab\L10), then writes probe-<Label>.json into -OutDir and exits.
    -Mode Gateway  Starts an OpenClaw gateway as the task's user (port -Port, token from <OutDir>\gateway.token,
                   state dir under %LOCALAPPDATA%\OffManualLab\L5\gw-task if the profile is loaded), waits for
                   /healthz, runs the same UNC checks, writes gateway-<Label>.json, then waits while the gateway
                   runs (until the task is ended, the gateway exits, or -GatewaySeconds elapses).

    LAB SHORTCUT: the gateway token is read from a file ACL'd to labA + SYSTEM + Administrators. The product will
    not do this (ARCHITECTURE.md section 2: DPAPI CurrentUser). Whether DPAPI CurrentUser works inside an S4U task
    is exactly what the Probe records (dpapi_* fields) - see L5 and L10.

    Never prints the token (hash prefix only).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Probe', 'Gateway')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [Parameter(Mandatory = $true)][string]$Label,
    [string]$SharePath = '',
    [string]$FileName = 'test.txt',
    [string]$InstallRoot = 'C:\OffManualLab\openclaw',
    [string]$NodeExe = '',
    [int]$Port = 18800,
    [int]$GatewaySeconds = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$log = Join-Path $OutDir ('runner-' + $Mode + '-' + $Label + '.log')
function Write-RunnerLog {
    param([string]$Text)
    Add-Content -LiteralPath $log -Value ((Get-LabTimestamp) + ' ' + $Text) -Encoding UTF8
}

function Get-ContextInfo {
    $s = Get-SessionInfo
    $groups = @()
    try {
        $groups = @((Invoke-LabNative -FilePath "$env:SystemRoot\System32\whoami.exe" -Arguments @('/groups', '/fo', 'csv', '/nh')).Output |
                    ConvertFrom-Csv -Header Name, Type, Sid, Attributes | ForEach-Object { $_.Sid })
    } catch { $null = $_ }
    $profileLoaded = $false
    if ($env:LOCALAPPDATA -and (Test-Path -LiteralPath $env:LOCALAPPDATA)) { $profileLoaded = $true }
    return [ordered]@{
        time            = (Get-LabTimestamp)
        user            = $s.User
        sid             = $s.Sid
        session_id      = $s.SessionId
        integrity       = $s.Integrity
        group_batch     = ($groups -contains 'S-1-5-3')
        group_interactive = ($groups -contains 'S-1-5-4')
        group_service   = ($groups -contains 'S-1-5-6')
        group_network   = ($groups -contains 'S-1-5-2')
        localappdata    = [string]$env:LOCALAPPDATA
        userprofile     = [string]$env:USERPROFILE
        profile_loaded  = $profileLoaded
    }
}

function Test-UncReads {
    $r = [ordered]@{}
    if (-not $SharePath) { $r['unc'] = 'no -SharePath'; return $r }
    foreach ($folder in @('ClientX', 'ClientY')) {
        $p = $SharePath.TrimEnd('\') + '\' + $folder + '\' + $FileName
        try { $null = [System.IO.File]::ReadAllText($p); $r[('unc_' + $folder)] = 'OK' }
        catch { $r[('unc_' + $folder)] = (Format-LabError $_) }
    }
    return $r
}

function Test-Dpapi {
    $r = [ordered]@{}
    try {
        Add-Type -AssemblyName System.Security
        $plain = [System.Text.Encoding]::UTF8.GetBytes((New-LabSecret 16))
        $blob = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        $back = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        $r['dpapi_roundtrip'] = $(if ([Convert]::ToBase64String($back) -eq [Convert]::ToBase64String($plain)) { 'OK' } else { 'MISMATCH' })
    } catch { $r['dpapi_roundtrip'] = (Format-LabError $_) }
    $blobPath = ''
    if ($env:LOCALAPPDATA) { $blobPath = Join-Path $env:LOCALAPPDATA 'OffManualLab\L10\currentuser.bin' }
    if ($blobPath -and (Test-Path -LiteralPath $blobPath)) {
        try {
            $bytes = [System.IO.File]::ReadAllBytes($blobPath)
            $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
            $expected = ''
            $hashFile = $blobPath + '.sha256prefix'
            if (Test-Path -LiteralPath $hashFile) { $expected = (Get-Content -LiteralPath $hashFile -Raw).Trim() }
            $got = Get-LabHashPrefix ([System.Text.Encoding]::UTF8.GetString($plain))
            $r['dpapi_l10_blob'] = $(if ($expected -and $got -eq $expected) { 'OK (matches L10 secret hash)' } else { 'decrypted, hash ' + $got + ' expected ' + $expected })
        } catch { $r['dpapi_l10_blob'] = (Format-LabError $_) }
    } else {
        $r['dpapi_l10_blob'] = 'no L10 blob at ' + $blobPath + ' (run L10 -Phase Protect as this user first)'
    }
    return $r
}

function Write-Json {
    param([string]$Name, $Data)
    $path = Join-Path $OutDir $Name
    Write-LabTextFile -Path $path -Text ($Data | ConvertTo-Json -Depth 6)
}

if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
Write-RunnerLog ('start mode=' + $Mode + ' label=' + $Label)

try {
    if ($Mode -eq 'Probe') {
        $data = Get-ContextInfo
        foreach ($kv in (Test-UncReads).GetEnumerator()) { $data[$kv.Key] = $kv.Value }
        foreach ($kv in (Test-Dpapi).GetEnumerator()) { $data[$kv.Key] = $kv.Value }
        Write-Json -Name ('probe-' + $Label + '.json') -Data $data
        Write-RunnerLog 'probe done'
        exit 0
    }

    # Gateway mode
    $tokenFile = Join-Path $OutDir 'gateway.token'
    $token = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
    $stateDir = ''
    if ($env:LOCALAPPDATA -and (Test-Path -LiteralPath $env:LOCALAPPDATA)) { $stateDir = Join-Path $env:LOCALAPPDATA ('OffManualLab\L5\gw-task-' + $Label) }
    else { $stateDir = Join-Path $OutDir ('state-' + $Label) }
    $inst = Resolve-OpenClawInstall -InstallRoot $InstallRoot -NodeExe $NodeExe
    $gw = Start-LabGateway -Install $inst -StateDir $stateDir -Port $Port -Token $token
    $status = Get-ContextInfo
    $status['gateway_pid'] = $gw.Process.Id
    $status['port'] = $Port
    $status['state_dir'] = $stateDir
    $status['token_hash'] = (Get-LabHashPrefix $token)
    $status['health_ms'] = -1
    Write-Json -Name ('gateway-' + $Label + '.json') -Data $status
    $status['doctor'] = ('exit ' + $gw.DoctorExit + ' in ' + $gw.DoctorMs + ' ms')
    $ms = Wait-LabHttpOk -Uri ('http://127.0.0.1:' + $Port + '/healthz') -TimeoutSec 180 -Timer $gw.Timer
    $status['health_ms'] = $ms
    $status['ready_ms'] = -1
    if ($ms -ge 0) { $status['ready_ms'] = Wait-LabHttpOk -Uri ('http://127.0.0.1:' + $Port + '/readyz') -TimeoutSec 90 -Timer $gw.Timer }
    foreach ($kv in (Test-UncReads).GetEnumerator()) { $status[$kv.Key] = $kv.Value }
    foreach ($kv in (Test-Dpapi).GetEnumerator()) { $status[$kv.Key] = $kv.Value }
    if ($ms -lt 0) {
        $status['log_tail'] = (@(Get-LabFileTail -Path $gw.StdErr -Lines 15) | ForEach-Object { Hide-LabSecretsInText -Text ([string]$_) -Secrets @($token) }) -join ' | '
    }
    Write-Json -Name ('gateway-' + $Label + '.json') -Data $status
    Write-RunnerLog ('gateway pid ' + $gw.Process.Id + ' health_ms ' + $ms)
    $limit = [int]::MaxValue
    if ($GatewaySeconds -gt 0) { $limit = $GatewaySeconds * 1000 }
    if ($limit -eq [int]::MaxValue) { $gw.Process.WaitForExit() } else { $null = $gw.Process.WaitForExit($limit) }
    if (-not $gw.Process.HasExited) { Stop-LabProcessTree -RootPid $gw.Process.Id }
    Write-RunnerLog 'gateway finished'
    exit 0
} catch {
    Write-RunnerLog ('ERROR ' + (Format-LabError $_))
    exit 1
}
