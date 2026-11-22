<#
.SYNOPSIS
    L9 - Is the Evergreen WebView2 Runtime present on Windows Server 2022 RDS (version?), and how much RAM do
    WebView2 instances use per session?

.DESCRIPTION
    Question (docs/LAB_VALIDATION.md L9): WebView2 runtime on Server 2022 RDS; RAM per Desk instance. Feeds ADR-007.

    What this script measures - and what it does NOT:
      - Runtime presence/version: the documented registry check (pv value) at
          HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}  (per-machine, 64-bit Windows)
          HKCU\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}              (per-user)
        "at least one of these regkeys must be present and defined with a version greater than 0.0.0.0"
        https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
        (section "Detect if a WebView2 Runtime is already installed"). Also checks the runtime folder and any
        WebView2 policies under HKLM\SOFTWARE\Policies\Microsoft\Edge\WebView2.
      - Memory: Working Set / Private Bytes of msedgewebview2.exe process trees that are ALREADY running (grouped by
        host app and session). It does not start a WebView2 host of its own. Microsoft Edge in --app mode is NOT an
        equivalent measurement, so it is not used. The real number for ADR-007 comes from re-running this script
        while the Desk (Tauri) build is open in each session: -HostProcessName <desk exe name without .exe>.
        Until then, RAM numbers here only describe whatever WebView2 apps happen to be running (often none on a
        fresh Server 2022 - recorded as such, result PARTIAL).
        Private Bytes of other users' processes are not readable without admin; run as labAdmin (elevated) to see
        all sessions, or as each user for their own session.
      - If the runtime is absent: prints the documented bootstrapper command. -Install (elevated) downloads the
        Evergreen Bootstrapper from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and runs
        "MicrosoftEdgeWebview2Setup.exe /silent /install" (per-machine when elevated; same distribution page).

    Exact commands:
      labAdmin (elevated):  ...\L9-webview2.ps1                     (detection + all sessions' WebView2 memory)
      labAdmin (elevated):  ...\L9-webview2.ps1 -Install            (only if not present)
      labA / labB:          ...\L9-webview2.ps1                     (confirms per-user view: HKCU key, own processes)
      Later, with Desk running in labA and labB sessions:
      labAdmin (elevated):  ...\L9-webview2.ps1 -HostProcessName offmanual-desk

    What to paste back: the output(s) or lab\results\L9-*.txt, then /lab-result L9.

    Pass criteria (measurable):
      - runtime_present: pv > 0.0.0.0 in HKLM (per-machine preferred for RDS) or HKCU; version recorded.
      - runtime_folder: msedgewebview2.exe exists under the runtime folder for that version.
      - memory: per host-app instance WS/Private recorded (PASS only when -HostProcessName matched running Desk
        instances in >= 2 sessions; otherwise PARTIAL with whatever was running).

    Leaves behind: nothing, unless -Install (then the WebView2 Runtime stays installed - intended; it is what the
    product's installer would add). The downloaded bootstrapper in %TEMP% is deleted. Transcripts in lab\results.
#>
[CmdletBinding()]
param(
    [string]$HostProcessName = '',
    [switch]$Install,
    [string]$BootstrapperUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
trap { Write-LabUnhandled $_; break }

$null = Start-LabTranscript -Id 'L9' -Suffix $env:USERNAME
$s = Write-SessionInfo
$clientGuid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'

function Get-Pv {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $p = Get-ItemProperty -LiteralPath $Path
    $prop = $p.PSObject.Properties['pv']
    if ($null -eq $prop) { return '' }
    return [string]$prop.Value
}

function Test-RealVersion { param([string]$v) return ($v -and $v -ne '0.0.0.0') }

function Get-RuntimeState {
    $is64 = [Environment]::Is64BitOperatingSystem
    $hklmPath = 'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\' + $clientGuid
    if ($is64) { $hklmPath = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + $clientGuid }
    $hkcuPath = 'HKCU:\Software\Microsoft\EdgeUpdate\Clients\' + $clientGuid
    return [pscustomobject]@{ HklmPath = $hklmPath; HklmPv = (Get-Pv $hklmPath); HkcuPath = $hkcuPath; HkcuPv = (Get-Pv $hkcuPath) }
}

Write-LabSection 'WebView2 Runtime (registry check from Microsoft Learn)'
$st = Get-RuntimeState
Set-LabValue 'hklm_pv' $st.HklmPv
Set-LabValue 'hkcu_pv' $st.HkcuPv
Write-LabInfo ($st.HklmPath + ' pv=' + $st.HklmPv)
Write-LabInfo ($st.HkcuPath + ' pv=' + $st.HkcuPv)
$present = (Test-RealVersion $st.HklmPv) -or (Test-RealVersion $st.HkcuPv)

if (-not $present -and $Install) {
    Write-LabSection 'Install (Evergreen Bootstrapper)'
    Assert-LabElevated -Why 'a per-machine WebView2 install'
    $tmp = Join-Path $env:TEMP 'MicrosoftEdgeWebview2Setup.exe'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $BootstrapperUrl -OutFile $tmp -UseBasicParsing
    $sig = Get-AuthenticodeSignature -FilePath $tmp
    Set-LabValue 'bootstrapper_signature' ($sig.Status.ToString() + ' ' + $(if ($null -ne $sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '' }))
    if ($sig.Status -ne 'Valid') { Add-LabCheck 'bootstrapper_signature' 'FAIL' ('signature ' + $sig.Status); Remove-Item -LiteralPath $tmp -Force; Write-Result; return }
    $t = New-LabTimer
    $p = Start-Process -FilePath $tmp -ArgumentList '/silent', '/install' -Wait -PassThru
    Set-LabValue 'install_exit' $p.ExitCode
    Set-LabValue 'install_ms' $t.ElapsedMilliseconds
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    $st = Get-RuntimeState
    Set-LabValue 'hklm_pv_after_install' $st.HklmPv
    $present = (Test-RealVersion $st.HklmPv) -or (Test-RealVersion $st.HkcuPv)
}

$version = $st.HklmPv
$scope = 'per-machine'
if (-not (Test-RealVersion $version)) { $version = $st.HkcuPv; $scope = 'per-user' }
if ($present) {
    Add-LabCheck 'runtime_present' 'PASS' ($scope + ' ' + $version)
    Set-LabValue 'runtime_version' $version
    Set-LabValue 'runtime_scope' $scope
    if ($scope -eq 'per-user') { Add-LabCheck 'runtime_scope' 'WARN' 'only a per-user runtime: other RDS users would not have it; install per-machine (elevated)' }
    $folders = @((Join-Path ${env:ProgramFiles(x86)} ('Microsoft\EdgeWebView\Application\' + $version)), (Join-Path $env:LOCALAPPDATA ('Microsoft\EdgeWebView\Application\' + $version)))
    $exe = $null
    foreach ($f in $folders) { $cand = Join-Path $f 'msedgewebview2.exe'; if (Test-Path -LiteralPath $cand) { $exe = $cand; break } }
    if ($exe) { Add-LabCheck 'runtime_folder' 'PASS' $exe; Set-LabValue 'runtime_exe' $exe }
    else { Add-LabCheck 'runtime_folder' 'WARN' ('msedgewebview2.exe not found in ' + ($folders -join ' or ')) }
} else {
    Add-LabCheck 'runtime_present' 'FAIL' 'WebView2 Runtime not installed (pv missing or 0.0.0.0 in HKLM and HKCU)'
    Write-LabInfo 'To install per-machine (elevated PowerShell), either re-run this script with -Install, or:'
    Write-LabInfo ('  Invoke-WebRequest -Uri ''' + $BootstrapperUrl + ''' -OutFile $env:TEMP\MicrosoftEdgeWebview2Setup.exe -UseBasicParsing')
    Write-LabInfo '  & $env:TEMP\MicrosoftEdgeWebview2Setup.exe /silent /install'
}

$edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
Set-LabValue 'edge_browser_present' (Test-Path -LiteralPath $edge)
$polKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2'
if (Test-Path -LiteralPath $polKey) {
    $pol = Get-ItemProperty -LiteralPath $polKey
    $names = @($pol.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object { $_.Name + '=' + $_.Value })
    Add-LabCheck 'webview2_policies' 'INFO' ($names -join '; ')
} else { Add-LabCheck 'webview2_policies' 'INFO' 'none' }

Write-LabSection 'Running WebView2 instances (msedgewebview2.exe trees)'
$all = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, SessionId, CommandLine)
$byPid = @{}
foreach ($p in $all) { $byPid[[int]$p.ProcessId] = $p }
$wv = @($all | Where-Object { $_.Name -ieq 'msedgewebview2.exe' })
# Browser (root) process: msedgewebview2.exe whose parent is NOT msedgewebview2.exe.
$roots = @($wv | Where-Object { $par = $byPid[[int]$_.ParentProcessId]; ($null -eq $par) -or ($par.Name -ine 'msedgewebview2.exe') })
Set-LabValue 'webview2_process_count' $wv.Count
Set-LabValue 'webview2_instance_count' $roots.Count
if ($roots.Count -eq 0) { Add-LabCheck 'memory' 'WARN' 'no WebView2 instances running in any visible session - nothing to measure (expected until the Desk build exists)' }
$sessionsWithHost = New-Object System.Collections.ArrayList
$i = 0
foreach ($r in $roots) {
    $i++
    $hostProc = $byPid[[int]$r.ParentProcessId]
    $hostName = '(exited)'
    if ($null -ne $hostProc) { $hostName = [string]$hostProc.Name }
    $m = Get-LabProcessTreeMemory -RootPid ([int]$r.ProcessId)
    $line = 'instance ' + $i + ': host ' + $hostName + ' session ' + $r.SessionId + ' processes ' + $m.Count + ' WS ' + $m.WsMB + ' MB Private ' + $m.PrivateMB + ' MB'
    if ($m.Count -eq 0) { $line += ' (not readable from this account; run elevated)' }
    Write-LabInfo $line
    Set-LabValue ('instance' + $i) $line
    if ($HostProcessName -and $hostName -ieq ($HostProcessName + '.exe')) {
        $null = $sessionsWithHost.Add([int]$r.SessionId)
        # Include the host process itself (the Desk exe) for a per-Desk total.
        $hm = $null
        try { $hp = Get-Process -Id ([int]$hostProc.ProcessId) -ErrorAction Stop; $hm = [math]::Round($hp.WorkingSet64 / 1MB, 1) } catch { $null = $_ }
        Set-LabValue ('desk_instance_session' + $r.SessionId) ('webview2 WS ' + $m.WsMB + ' MB, Private ' + $m.PrivateMB + ' MB; host WS ' + $hm + ' MB')
    }
}
if ($HostProcessName) {
    $uniq = @($sessionsWithHost | Sort-Object -Unique)
    if ($uniq.Count -ge 2) { Add-LabCheck 'memory' 'PASS' ($HostProcessName + ' WebView2 instances measured in sessions ' + ($uniq -join ',')) }
    else { Add-LabCheck 'memory' 'WARN' ($HostProcessName + ' WebView2 instances found in ' + $uniq.Count + ' session(s); need >= 2') }
} elseif ($roots.Count -gt 0) {
    Add-LabCheck 'memory' 'WARN' 'recorded memory of OTHER WebView2 apps only; re-run with -HostProcessName <Desk exe> once Desk exists (ADR-007 number)'
}
Write-Result
