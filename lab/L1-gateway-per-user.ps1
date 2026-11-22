<#
.SYNOPSIS
    L1 - Does a native Windows OpenClaw gateway run per user under RDS, from one shared read-only install,
    and how much RAM does each idle (and optionally busy) gateway use? Which ports does it bind?

.DESCRIPTION
    Question (docs/LAB_VALIDATION.md L1): Does a native Windows OpenClaw gateway run per user under RDS?
    What RAM per idle/busy gateway? 5 at once?

    Roles:
      -Role Install   labAdmin, ELEVATED PowerShell. Into -Root (default C:\OffManualLab):
                        <Root>\node      official node-v<NodeVersion>-win-x64.zip, SHA-256 checked against SHASUMS256.txt
                        <Root>\openclaw  npm install --prefix "<Root>\openclaw" --omit=dev --no-audit --no-fund openclaw@2026.11.6
                                         (postinstall NOT skipped)
                        <Root>\plugins\offmanual-lab-probe   tiny local plugin for the optional -ProbePlugin sub-step
                      then sets each folder's ACL to SYSTEM + Administrators Full, Users Read & Execute (no inheritance).
      -Role Run       labA, then labB (normal, non-elevated PowerShell in each user's own RDP session).
                      Per gateway: own state dir %LOCALAPPDATA%\OffManualLab\L1\gw-<port>, own port, own random token
                      (env only), hardened config (below), "doctor --fix --yes --non-interactive", then
                      "node openclaw.mjs gateway run --port <p> --bind loopback --auth token". Waits for /readyz,
                      idles 60 s, samples Working Set + Private Bytes of the node process tree, records EVERY listening
                      port of the tree, then HOLDS until you press Enter (so the other user can run at the same time).
      -Role Cleanup   Each user: deletes %LOCALAPPDATA%\OffManualLab\L1. labAdmin (elevated) with -RemoveInstall also
                      deletes <Root>\openclaw, <Root>\node and <Root>\plugins.

    OpenClaw facts used (pinned 2026.11.6; see docs/OPENCLAW_NOTES.md sections 2-4 and common.ps1 OPENCLAW header):
      - Native Windows CLI + Gateway: https://docs.openclaw.ai/platforms/windows.md (the Windows Hub "native gateway"
        option says "Windows Server is not supported" - we do not use Windows Hub).
      - npm package "openclaw", entry openclaw.mjs, spawn "<node> <pkg>\openclaw.mjs gateway ...", install do not flatten:
        https://docs.openclaw.ai/gateway/embedding.md ; npm flags: https://docs.openclaw.ai/install.md (npm tab:
        --allow-scripts=openclaw on npm 12 / 11.16+, without it on npm <= 11.15)
      - Node: engines ">=24.16.0 <25 || >=26.1.0"; use 24.22.1+ / 26.12.1+: https://docs.openclaw.ai/install/node-compatibility.md
      - Node zip + SHASUMS256.txt: https://nodejs.org/dist/v<version>/
      - Run flags --port/--bind/--auth, token from OPENCLAW_GATEWAY_TOKEN: https://docs.openclaw.ai/cli/gateway/running.md
      - Env OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH, OPENCLAW_NO_RESPAWN, OPENCLAW_NO_AUTO_UPDATE, OPENCLAW_DISABLE_BONJOUR,
        DO_NOT_TRACK, OPENCLAW_ALLOW_MULTI_GATEWAY: https://docs.openclaw.ai/help/environment.md ; CLAWHUB_DISABLE_TELEMETRY
        is source-only (OPENCLAW_NOTES.md section 2)
      - Config: gateway{mode:"local",port,bind:"loopback",auth:{mode:"token",rateLimit:{exemptLoopback:false}},
        controlUi:{enabled:false},terminal:{enabled:false}}, update{checkOnStart:false,auto:{enabled:false}},
        telemetry{enabled:false}, plugins{deny:["telegram","browser","device-pair"]}:
        https://docs.openclaw.ai/gateway/config-gateway.md, https://docs.openclaw.ai/gateway/config-runtime.md,
        https://docs.openclaw.ai/tools/plugin.md
      - Doctor before start: https://docs.openclaw.ai/cli/doctor/running.md ; readiness /readyz: https://docs.openclaw.ai/gateway/health.md
      - Derived ports base+1 (MCP Apps), base+2 (browser control), base+9..+110 (CDP); base ports >= 120 apart:
        https://docs.openclaw.ai/gateway/multiple-gateways.md -> default -PortStep 120.
        NOTE: ARCHITECTURE.md section 4 reserves 18800-19799 for gateways = only ~8 gateways at a 120 stride, unless
        this run shows that only the base port listens (check single_port_only).
      - Plugin from a fixed folder: plugins.load.paths + plugins.entries.<id>.enabled; manifest openclaw.plugin.json;
        entry definePluginEntry from "openclaw/plugin-sdk/plugin-entry": https://docs.openclaw.ai/plugins/manifest.md,
        https://docs.openclaw.ai/plugins/building-plugins.md
      - UNVERIFIED (this script measures it): whether a second gateway of ANOTHER Windows user needs
        OPENCLAW_ALLOW_MULTI_GATEWAY=1 (run without first; if it fails, re-run with -AllowMultiGateway and record both);
        whether a load-path plugin resolves "openclaw/plugin-sdk/*" from outside the package folder.
      - UNVERIFIED - adjust: -BusyModel for the optional busy turn (x-openclaw-model header; model "openclaw/default"
        documented in https://docs.openclaw.ai/gateway/openai-http-api.md). Needs a provider key in the user's env.

    Prerequisites: lab built per lab\README.md; outbound internet during -Role Install.

    Exact commands (lab folder at C:\OffManualLab\lab, see README):
      labAdmin (elevated):  powershell -ExecutionPolicy Bypass -File C:\OffManualLab\lab\L1-gateway-per-user.ps1 -Role Install
      labA (RDP session 1): powershell -ExecutionPolicy Bypass -File C:\OffManualLab\lab\L1-gateway-per-user.ps1 -Role Run -BasePort 18800
                            ... leave it holding (do not press Enter yet) ...
      labB (RDP session 2): powershell -ExecutionPolicy Bypass -File C:\OffManualLab\lab\L1-gateway-per-user.ps1 -Role Run -BasePort 18920
                            (if labB's gateway does not become ready: press Enter in labB, re-run with -AllowMultiGateway)
                            When labB shows ">>> Gateways are running", press Enter in labA FIRST (labA then sees labB's
                            gateway), then press Enter in labB (labB saw labA's gateway at its start).
      Scaling (labA alone): ... -Role Run -Count 5 -BasePort 18800      (ports 18800,18920,19040,19160,19280)
      Plugin probe (labA):  ... -Role Run -ProbePlugin -NoWait
      Optional busy turn:   $env:ANTHROPIC_API_KEY = '<key>' ; ... -Role Run -Busy -BusyModel '<provider/model>'
      Cleanup:              each user: ... -Role Cleanup ; labAdmin (elevated): ... -Role Cleanup -RemoveInstall

    What to paste back: the whole console output of each run (Install, labA Run, labB Run, Count 5, ProbePlugin) or
    the transcript files C:\OffManualLab\lab\results\L1-*.txt. Then type /lab-result L1.

    Pass criteria (measurable):
      - Install: Node SHA-256 matches SHASUMS256; npm exit 0; openclaw --version = 2026.11.6; folder ACLs protected
        (SYSTEM F, Administrators F, Users RX).
      - Run (each user): doctor exit recorded; every gateway answers /readyz 200 within -StartTimeoutSec (default 180 s);
        POST /tools/invoke with the token is not 401/403 and without it is 401/403; idle WS + Private Bytes recorded.
      - Ports: all listeners loopback-only (FAIL otherwise); single_port_only PASS only if the base port is the ONLY
        listener of the tree (WARN with the list otherwise - that decides single-port leases vs a 120-port stride).
      - Concurrency: the labB run sees >= 1 node.exe loopback listener in another session (labA's) while its own gateway
        is ready -> concurrent_other_session = PASS. allow_multi_gateway recorded.
      - Scaling: -Count 5 run has 5 ready gateways; total RAM recorded.
      - ProbePlugin: plugin_listed / plugin_load_errors recorded (INFO; feeds the guard plugin design).
      Overall L1 PASS when Install, labA Run and labB Run are PASS (labB shows concurrency) and numbers are recorded.

    Leaves behind:
      - Install: C:\OffManualLab\{node,openclaw,plugins} (removed by -Role Cleanup -RemoveInstall); npm cache in
        labAdmin's profile; %TEMP% download of the Node zip is deleted.
      - Run: %LOCALAPPDATA%\OffManualLab\L1 per user (removed by -Role Cleanup). Gateways are stopped at the end.
        Also possibly %LOCALAPPDATA%\OpenClaw\locks (OpenClaw state-owner lock, per user) and %TEMP%\node-compile-cache.
      - Possibly %USERPROFILE%\.openclaw if OpenClaw ignores the state-dir override (reported; delete by hand).
      - Transcripts in lab\results.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Install', 'Run', 'Cleanup')][string]$Role,
    [string]$Root = 'C:\OffManualLab',
    [string]$OpenClawVersion = '2026.11.6',
    [string]$NodeVersion = '24.22.3',
    [switch]$UseSystemNode,
    [string]$NodeExe = '',
    [int]$BasePort = 18800,
    [ValidateRange(1, 8)][int]$Count = 1,
    [int]$PortStep = 120,
    [int]$IdleSeconds = 60,
    [int]$Samples = 3,
    [int]$StartTimeoutSec = 180,
    [switch]$AllowMultiGateway,
    [switch]$SkipDoctor,
    [switch]$ProbePlugin,
    [switch]$NoWait,
    [switch]$Busy,
    [string]$BusyModel = '',
    [string[]]$ExtraGatewayArgs = @(),
    [switch]$RemoveInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
trap { Write-LabUnhandled $_; break }

$InstallRoot = Join-Path $Root 'openclaw'
$NodeRoot = Join-Path $Root 'node'
$PluginRoot = Join-Path $Root 'plugins'
$ProbeId = 'offmanual-lab-probe'
$ProbeDir = Join-Path $PluginRoot $ProbeId

$null = Start-LabTranscript -Id 'L1' -Suffix ($Role + '-' + $env:USERNAME)
$session = Write-SessionInfo
Set-LabValue 'role' $Role
Set-LabValue 'root' $Root

function Test-NodeSupported {
    param([string]$Version)
    if ($Version -notmatch '^v?(\d+)\.(\d+)\.(\d+)') { return 'unsupported' }
    $maj = [int]$Matches[1]; $min = [int]$Matches[2]; $pat = [int]$Matches[3]
    if ($maj -eq 24) {
        if ($min -gt 22 -or ($min -eq 22 -and $pat -ge 1)) { return 'recommended' }
        if ($min -ge 16) { return 'supported-below-security-recommendation' }
    }
    if ($maj -eq 26) {
        if ($min -gt 12 -or ($min -eq 12 -and $pat -ge 1)) { return 'recommended' }
        if ($min -ge 1) { return 'supported-below-security-recommendation' }
    }
    return 'unsupported'
}

function Set-ReadOnlyForUsers {
    param([string]$Path)
    $null = Invoke-LabNative -FilePath 'icacls.exe' -Arguments @($Path, '/reset', '/T', '/C', '/Q')
    $ic = Invoke-LabNative -FilePath 'icacls.exe' -Arguments @($Path, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-32-545:(OI)(CI)RX', '/C', '/Q')
    $acl = Get-Acl -LiteralPath $Path
    $inherited = @($acl.Access | Where-Object { $_.IsInherited })
    $aceText = @($acl.Access | ForEach-Object { $_.IdentityReference.Value + ':' + $_.FileSystemRights }) -join '; '
    Set-LabValue ('acl.' + (Split-Path -Leaf $Path)) $aceText
    if ($ic.ExitCode -eq 0 -and $inherited.Count -eq 0 -and $acl.AreAccessRulesProtected) { Add-LabCheck ('acl_' + (Split-Path -Leaf $Path)) 'PASS' $aceText }
    else { Add-LabCheck ('acl_' + (Split-Path -Leaf $Path)) 'FAIL' ('icacls exit ' + $ic.ExitCode + '; inherited ACEs ' + $inherited.Count) }
}

# ------------------------------------------------------------------------------------------------
if ($Role -eq 'Install') {
    Assert-LabElevated -Why 'installing into a shared folder and setting its ACL'
    foreach ($d in @($Root, $InstallRoot, $PluginRoot)) { if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }

    Write-LabSection 'Node runtime'
    $nodeExePath = ''
    if ($UseSystemNode) {
        $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($null -eq $cmd) { Add-LabCheck 'node_present' 'FAIL' 'node.exe not on PATH and -UseSystemNode given'; Write-Result; return }
        $nodeExePath = $cmd.Source
        Add-LabCheck 'node_source' 'INFO' ('system Node at ' + $nodeExePath)
    } else {
        $zipName = 'node-v' + $NodeVersion + '-win-x64.zip'
        $base = 'https://nodejs.org/dist/v' + $NodeVersion + '/'
        $tmp = Join-Path $env:TEMP ('omlab-node-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $zip = Join-Path $tmp $zipName
            $sums = Join-Path $tmp 'SHASUMS256.txt'
            Invoke-WebRequest -Uri ($base + $zipName) -OutFile $zip -UseBasicParsing
            Invoke-WebRequest -Uri ($base + 'SHASUMS256.txt') -OutFile $sums -UseBasicParsing
            $expected = ''
            foreach ($l in (Get-Content -LiteralPath $sums)) { if ($l -match ('^([0-9a-f]{64})\s+' + [regex]::Escape($zipName) + '$')) { $expected = $Matches[1] } }
            $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
            Set-LabValue 'node_zip_sha256' $actual
            if (-not $expected -or $actual -ne $expected) { Add-LabCheck 'node_zip_sha256' 'FAIL' ('expected ' + $expected + ' got ' + $actual); Write-Result; return }
            Add-LabCheck 'node_zip_sha256' 'PASS' ($zipName + ' matches SHASUMS256.txt')
            Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
            $inner = Join-Path $tmp ('node-v' + $NodeVersion + '-win-x64')
            if (Test-Path -LiteralPath $NodeRoot) { Remove-Item -LiteralPath $NodeRoot -Recurse -Force }
            Move-Item -LiteralPath $inner -Destination $NodeRoot
        } finally {
            Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
        $nodeExePath = Join-Path $NodeRoot 'node.exe'
    }
    $nodeVer = [string]((Invoke-LabNative -FilePath $nodeExePath -Arguments @('--version')).Output | Select-Object -First 1)
    Set-LabValue 'node_path' $nodeExePath
    Set-LabValue 'node_version' $nodeVer
    $support = Test-NodeSupported $nodeVer
    if ($support -eq 'recommended') { Add-LabCheck 'node_supported' 'PASS' $nodeVer }
    elseif ($support -eq 'unsupported') { Add-LabCheck 'node_supported' 'FAIL' ($nodeVer + ' is outside OpenClaw''s range (>=24.16 <25 or >=26.1)'); Write-Result; return }
    else { Add-LabCheck 'node_supported' 'WARN' ($nodeVer + ' accepted but below 24.22.1 / 26.12.1 security recommendation') }

    Write-LabSection ('npm install --prefix ' + $InstallRoot + ' openclaw@' + $OpenClawVersion)
    $nodeDir = Split-Path -Parent $nodeExePath
    $npm = Join-Path $nodeDir 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npm)) { $npm = 'npm.cmd' }
    $savedPath = $env:PATH
    $env:PATH = $nodeDir + ';' + $env:PATH   # postinstall scripts run "node ..."
    try {
        $npmVersion = [string]((Invoke-LabNative -FilePath $npm -Arguments @('--version')).Output | Select-Object -First 1)
        Set-LabValue 'npm_version' $npmVersion
        $npmArgs = @('install', '--prefix', $InstallRoot, '--omit=dev', '--no-audit', '--no-fund', ('openclaw@' + $OpenClawVersion))
        if ($npmVersion -match '^(\d+)\.(\d+)') {
            $nmaj = [int]$Matches[1]; $nmin = [int]$Matches[2]
            if ($nmaj -ge 12 -or ($nmaj -eq 11 -and $nmin -ge 16)) { $npmArgs += '--allow-scripts=openclaw' }
        }
        Write-LabInfo ($npm + ' ' + ($npmArgs -join ' '))
        $t = New-LabTimer
        $npmRun = Invoke-LabNative -FilePath $npm -Arguments $npmArgs
        $t.Stop()
    } finally { $env:PATH = $savedPath }
    foreach ($l in @($npmRun.Output | Select-Object -Last 25)) { Write-LabInfo ('| ' + [string]$l) }
    Set-LabValue 'npm_exit' $npmRun.ExitCode
    Set-LabValue 'install_ms' $t.ElapsedMilliseconds
    if ($npmRun.ExitCode -ne 0) { Add-LabCheck 'npm_install' 'FAIL' ('npm exit code ' + $npmRun.ExitCode); Write-Result; return }
    Add-LabCheck 'npm_install' 'PASS' ('took ' + [int]($t.ElapsedMilliseconds / 1000) + ' s')

    $inst = Resolve-OpenClawInstall -InstallRoot $InstallRoot -NodeExe $nodeExePath
    Set-LabValue 'openclaw_version' $inst.Version
    Set-LabValue 'openclaw_entry' $inst.Entry
    $files = @(Get-ChildItem -LiteralPath $InstallRoot -Recurse -File -Force -ErrorAction SilentlyContinue)
    Set-LabValue 'install_files' $files.Count
    Set-LabValue 'install_size_mb' ([math]::Round((($files | Measure-Object -Property Length -Sum).Sum) / 1MB, 1))
    $ver = Invoke-LabOpenClawCli -Install $inst -Arguments @('--version') -TimeoutSec 120
    Set-LabValue 'openclaw_cli_version_output' $ver.Output
    if ($ver.ExitCode -eq 0 -and $ver.Output -match [regex]::Escape($OpenClawVersion)) { Add-LabCheck 'cli_version' 'PASS' $ver.Output }
    else { Add-LabCheck 'cli_version' 'FAIL' ('exit ' + $ver.ExitCode + ': ' + $ver.Output) }

    Write-LabSection 'Probe plugin (for the optional -ProbePlugin sub-step)'
    New-Item -ItemType Directory -Path $ProbeDir -Force | Out-Null
    Write-LabTextFile -Path (Join-Path $ProbeDir 'openclaw.plugin.json') -Text '{"id":"offmanual-lab-probe","name":"Lab probe","description":"x","activation":{"onStartup":true},"configSchema":{"type":"object","additionalProperties":false,"properties":{}}}'
    Write-LabTextFile -Path (Join-Path $ProbeDir 'package.json') -Text '{"name":"offmanual-lab-probe","version":"0.0.1","type":"module","openclaw":{"extensions":["./index.js"]}}'
    Write-LabTextFile -Path (Join-Path $ProbeDir 'index.js') -Text @'
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
export default definePluginEntry({ id:"offmanual-lab-probe", name:"Lab probe", description:"x", register(api){ api.on("before_install", () => ({ block:true, blockReason:"lab" })); } });
'@
    Add-LabCheck 'probe_plugin_files' 'PASS' $ProbeDir

    Write-LabSection 'Folder ACLs (SYSTEM F, Administrators F, Users RX, inheritance removed)'
    foreach ($d in @($InstallRoot, $PluginRoot)) { Set-ReadOnlyForUsers -Path $d }
    if (-not $UseSystemNode) { Set-ReadOnlyForUsers -Path $NodeRoot }
    Write-Result
    return
}

# ------------------------------------------------------------------------------------------------
$stateRoot = Join-Path $env:LOCALAPPDATA 'OffManualLab\L1'

if ($Role -eq 'Cleanup') {
    Write-LabSection 'Cleanup'
    if (Test-Path -LiteralPath $stateRoot) { Remove-Item -LiteralPath $stateRoot -Recurse -Force; Add-LabCheck 'remove_state' 'PASS' $stateRoot }
    else { Add-LabCheck 'remove_state' 'PASS' ('nothing at ' + $stateRoot) }
    if ($RemoveInstall) {
        Assert-LabElevated -Why 'removing the shared install'
        foreach ($d in @($InstallRoot, $NodeRoot, $PluginRoot)) {
            if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force; Add-LabCheck ('remove_' + (Split-Path -Leaf $d)) 'PASS' $d }
        }
    }
    $dot = Join-Path $env:USERPROFILE '.openclaw'
    if (Test-Path -LiteralPath $dot) { Add-LabCheck 'userprofile_dot_openclaw' 'INFO' ($dot + ' exists; delete by hand if L1 created it') }
    $locks = Join-Path $env:LOCALAPPDATA 'OpenClaw'
    if (Test-Path -LiteralPath $locks) { Add-LabCheck 'localappdata_openclaw' 'INFO' ($locks + ' exists (OpenClaw state-owner locks); delete by hand when done') }
    Write-Result
    return
}

# ------------------------------------------------------------------------------------------------
# Role Run
if ($session.IsElevated) { Write-LabWarn 'You are elevated. Run -Role Run from a normal (non-admin) PowerShell as labA / labB.' }
$inst = Resolve-OpenClawInstall -InstallRoot $InstallRoot -NodeExe $NodeExe
Set-LabValue 'openclaw_version' $inst.Version
Set-LabValue 'node' ($inst.NodeExe + ' ' + $inst.NodeVersion)
Set-LabValue 'state_root' $stateRoot
Set-LabValue 'count' $Count
Set-LabValue 'base_port' $BasePort
Set-LabValue 'port_step' $PortStep
Set-LabValue 'allow_multi_gateway' ([bool]$AllowMultiGateway)
Set-LabValue 'probe_plugin' ([bool]$ProbePlugin)

Write-LabSection 'Shared install is read-only for this user'
$probe = Join-Path $InstallRoot ('write-test-' + $env:USERNAME + '.tmp')
try {
    [System.IO.File]::WriteAllText($probe, 'x')
    Remove-Item -LiteralPath $probe -Force
    if ($session.IsAdminMember) { Add-LabCheck 'install_readonly_for_user' 'INFO' 'writable, but this user is an administrator' }
    else { Add-LabCheck 'install_readonly_for_user' 'WARN' 'a non-admin user can write into the shared install folder; fix the ACL' }
} catch {
    Add-LabCheck 'install_readonly_for_user' 'PASS' (Format-LabError $_)
}
$pkgStampBefore = (Get-Item -LiteralPath $inst.PackageDir).LastWriteTimeUtc

$dotOpenclaw = Join-Path $env:USERPROFILE '.openclaw'
$dotExistedBefore = Test-Path -LiteralPath $dotOpenclaw
$pluginPaths = @(); $pluginIds = @()
if ($ProbePlugin) {
    if (Test-Path -LiteralPath (Join-Path $ProbeDir 'openclaw.plugin.json')) { $pluginPaths = @($ProbeDir); $pluginIds = @($ProbeId) }
    else { Add-LabCheck 'probe_plugin_present' 'FAIL' ($ProbeDir + ' missing; re-run -Role Install') }
}

Write-LabSection ('Starting ' + $Count + ' gateway(s)')
$gateways = New-Object System.Collections.ArrayList
$tokens = @()
for ($i = 0; $i -lt $Count; $i++) {
    $port = $BasePort + ($i * $PortStep)
    if (Test-LabTcpPort -Port $port -TimeoutMs 500) {
        Add-LabCheck ('port_free_' + $port) 'FAIL' 'something already listens on this port; choose another -BasePort'
        continue
    }
    $token = New-LabSecret
    $tokens += $token
    $stateDir = Join-Path $stateRoot ('gw-' + $port)
    $gw = Start-LabGateway -Install $inst -StateDir $stateDir -Port $port -Token $token -EnableChatCompletions:$Busy `
        -AllowMultiGateway:$AllowMultiGateway -SkipDoctor:$SkipDoctor -PluginPaths $pluginPaths -PluginIds $pluginIds -ExtraArgs $ExtraGatewayArgs
    $gw | Add-Member -NotePropertyName Token -NotePropertyValue $token
    $gw | Add-Member -NotePropertyName HealthMs -NotePropertyValue -1
    $gw | Add-Member -NotePropertyName ReadyMs -NotePropertyValue -1
    $null = $gateways.Add($gw)
    Set-LabValue ('gw' + $port + '.doctor') ('exit ' + $gw.DoctorExit + ' in ' + $gw.DoctorMs + ' ms')
    if ($null -ne $gw.DoctorExit -and $gw.DoctorExit -ne 0) {
        Add-LabCheck ('doctor_' + $port) 'WARN' ('doctor --fix exit ' + $gw.DoctorExit + ': ' + ((($gw.DoctorOutput -split "`r?`n") | Select-Object -Last 3) -join ' | '))
    }
    Write-LabInfo ('port ' + $port + ' pid ' + $gw.Process.Id + ' token ' + (Get-LabHashPrefix $token) + ' state ' + $stateDir + ' doctor exit ' + $gw.DoctorExit)
}

foreach ($gw in $gateways) {
    $gw.HealthMs = Wait-LabHttpOk -Uri ('http://127.0.0.1:' + $gw.Port + '/healthz') -TimeoutSec $StartTimeoutSec -Timer $gw.Timer
    if ($gw.HealthMs -ge 0) { $gw.ReadyMs = Wait-LabHttpOk -Uri ('http://127.0.0.1:' + $gw.Port + '/readyz') -TimeoutSec 90 -Timer $gw.Timer }
    Set-LabValue ('gw' + $gw.Port + '.health_ms') $gw.HealthMs
    Set-LabValue ('gw' + $gw.Port + '.ready_ms') $gw.ReadyMs
    if ($gw.ReadyMs -ge 0) {
        Add-LabCheck ('ready_' + $gw.Port) 'PASS' ('healthz ' + $gw.HealthMs + ' ms, readyz ' + $gw.ReadyMs + ' ms after launch')
    } elseif ($gw.HealthMs -ge 0) {
        $rz = Invoke-LabHttp -Uri ('http://127.0.0.1:' + $gw.Port + '/readyz')
        Add-LabCheck ('ready_' + $gw.Port) 'WARN' ('live (healthz ' + $gw.HealthMs + ' ms) but /readyz not 200 within 90 s: ' + $rz.StatusCode + ' ' + ($rz.Body -replace '\s+', ' '))
    } else {
        $exited = $gw.Process.HasExited
        $detail = 'no /healthz within ' + $StartTimeoutSec + ' s; process exited=' + $exited
        if ($exited) { $detail += ' exitcode=' + $gw.Process.ExitCode }
        if (-not $AllowMultiGateway) { $detail += ' (if another gateway runs on this host, retry with -AllowMultiGateway and record both)' }
        Add-LabCheck ('ready_' + $gw.Port) 'FAIL' $detail
        Write-LabGatewayLogTail -Gateway $gw -Secrets $tokens
    }
}
$healthy = @($gateways | Where-Object { $_.HealthMs -ge 0 })
$ready = @($gateways | Where-Object { $_.ReadyMs -ge 0 })
Set-LabValue 'live_count' $healthy.Count
Set-LabValue 'ready_count' $ready.Count

if ($healthy.Count -gt 0) {
    Write-LabSection 'Token sanity (full test is L2): POST /tools/invoke'
    $toolsBody = '{"tool":"sessions_list","args":{}}'
    foreach ($gw in $healthy) {
        $base = 'http://127.0.0.1:' + $gw.Port
        $withTok = Invoke-LabHttp -Uri ($base + '/tools/invoke') -Method 'POST' -Body $toolsBody -Headers @{ Authorization = ('Bearer ' + $gw.Token) }
        $noTok = Invoke-LabHttp -Uri ($base + '/tools/invoke') -Method 'POST' -Body $toolsBody
        $ok = ($withTok.StatusCode -ne 0 -and $withTok.StatusCode -ne 401 -and $withTok.StatusCode -ne 403) -and ($noTok.StatusCode -eq 401 -or $noTok.StatusCode -eq 403)
        $st = 'FAIL'; if ($ok) { $st = 'PASS' }
        Add-LabCheck ('token_sanity_' + $gw.Port) $st ('/tools/invoke with token=' + $withTok.StatusCode + ', without=' + $noTok.StatusCode)
    }

    Write-LabSection 'Listening ports of each gateway process tree'
    foreach ($gw in $healthy) {
        $ports = @(Get-LabGatewayListeners -Gateway $gw)
        $portText = @($ports | ForEach-Object { $_.LocalAddress + ':' + $_.LocalPort + '(pid ' + $_.OwningProcess + ')' }) -join ','
        Set-LabValue ('gw' + $gw.Port + '.listening') $portText
        $nonLoop = @($ports | Where-Object { $_.LocalAddress -ne '127.0.0.1' -and $_.LocalAddress -ne '::1' })
        if ($nonLoop.Count -gt 0) { Add-LabCheck ('loopback_only_' + $gw.Port) 'FAIL' ('non-loopback listeners: ' + $portText) }
        else { Add-LabCheck ('loopback_only_' + $gw.Port) 'PASS' $portText }
        $others = @($ports | Where-Object { [int]$_.LocalPort -ne $gw.Port } | ForEach-Object { [int]$_.LocalPort } | Sort-Object -Unique)
        if ($others.Count -eq 0) { Add-LabCheck ('single_port_only_' + $gw.Port) 'PASS' 'only the base port listens (single-port leases are possible)' }
        else { Add-LabCheck ('single_port_only_' + $gw.Port) 'WARN' ('extra listeners at offsets ' + (@($others | ForEach-Object { '+' + ($_ - $gw.Port) }) -join ',') + ' -> keep a port stride') }
    }

    Write-LabSection ('Idle ' + $IdleSeconds + ' s, then ' + $Samples + ' memory samples 5 s apart')
    Start-Sleep -Seconds $IdleSeconds
    $totWsAvg = 0.0; $totPvAvg = 0.0
    foreach ($gw in $healthy) {
        $ws = @(); $pv = @(); $last = $null
        for ($s = 0; $s -lt $Samples; $s++) {
            $m = Get-LabProcessTreeMemory -RootPid $gw.Process.Id
            $ws += $m.WsMB; $pv += $m.PrivateMB; $last = $m
            if ($s -lt ($Samples - 1)) { Start-Sleep -Seconds 5 }
        }
        $wsAvg = [math]::Round((($ws | Measure-Object -Average).Average), 1)
        $wsMax = [math]::Round((($ws | Measure-Object -Maximum).Maximum), 1)
        $pvAvg = [math]::Round((($pv | Measure-Object -Average).Average), 1)
        $pvMax = [math]::Round((($pv | Measure-Object -Maximum).Maximum), 1)
        $totWsAvg += $wsAvg; $totPvAvg += $pvAvg
        Set-LabValue ('gw' + $gw.Port + '.idle_ws_mb_avg') $wsAvg
        Set-LabValue ('gw' + $gw.Port + '.idle_ws_mb_max') $wsMax
        Set-LabValue ('gw' + $gw.Port + '.idle_private_mb_avg') $pvAvg
        Set-LabValue ('gw' + $gw.Port + '.idle_private_mb_max') $pvMax
        Set-LabValue ('gw' + $gw.Port + '.process_count') $last.Count
        Write-LabInfo ('port ' + $gw.Port + ': WS avg ' + $wsAvg + ' MB (max ' + $wsMax + '), Private avg ' + $pvAvg + ' MB (max ' + $pvMax + '), processes ' + $last.Count)
        foreach ($p in $last.Processes) { Write-LabInfo ('    pid ' + $p.Pid + ' ' + $p.Name + ' WS ' + $p.WsMB + ' MB Private ' + $p.PrivateMB + ' MB') }
        Add-LabCheck ('ram_recorded_' + $gw.Port) 'PASS' ('idle WS ' + $wsAvg + ' MB, Private ' + $pvAvg + ' MB')
    }
    Set-LabValue 'total_idle_ws_mb' ([math]::Round($totWsAvg, 1))
    Set-LabValue 'total_idle_private_mb' ([math]::Round($totPvAvg, 1))
    Set-LabValue 'per_gateway_idle_ws_mb' ([math]::Round($totWsAvg / $healthy.Count, 1))
    Set-LabValue 'per_gateway_idle_private_mb' ([math]::Round($totPvAvg / $healthy.Count, 1))

    if ($ProbePlugin -and $pluginIds.Count -gt 0) {
        Write-LabSection 'Probe plugin from plugins.load.paths'
        $gw = $healthy[0]
        $logText = ''
        foreach ($f in @($gw.StdOut, $gw.StdErr)) { $logText += ((Get-LabFileTail -Path $f -Lines 2000) -join "`n") + "`n" }
        $mentions = @(($logText -split "`n") | Where-Object { $_ -match [regex]::Escape($ProbeId) -or $_ -match 'plugin-sdk|ERR_MODULE_NOT_FOUND|Cannot find (package|module)' })
        foreach ($l in ($mentions | Select-Object -First 15)) { Write-LabInfo ('log| ' + (Hide-LabSecretsInText -Text $l -Secrets $tokens)) }
        $loadErr = @($mentions | Where-Object { $_ -match 'ERR_MODULE_NOT_FOUND|Cannot find (package|module)|fail|error' })
        Set-LabValue 'plugin_log_mentions' $mentions.Count
        Set-LabValue 'plugin_load_errors' $loadErr.Count
        $cliEnv = Get-LabOpenClawBaseEnv -StateDir $gw.StateDir -ConfigPath $gw.Config -Token $gw.Token -AllowMultiGateway:$AllowMultiGateway
        $pl = Invoke-LabOpenClawCli -Install $inst -Arguments @('plugins', 'list', '--json') -Environment $cliEnv -WorkingDirectory $gw.StateDir -Secrets @($gw.Token) -TimeoutSec 120
        $listed = ($pl.Output -match [regex]::Escape($ProbeId))
        $snippet = ''
        $idx = $pl.Output.IndexOf($ProbeId)
        if ($idx -ge 0) { $snippet = $pl.Output.Substring([math]::Max(0, $idx - 80), [math]::Min(400, $pl.Output.Length - [math]::Max(0, $idx - 80))) -replace '\s+', ' ' }
        Set-LabValue 'plugin_list_exit' $pl.ExitCode
        Set-LabValue 'plugin_listed' $listed
        Set-LabValue 'plugin_list_snippet' $snippet
        if ($listed -and $loadErr.Count -eq 0) { Add-LabCheck 'probe_plugin' 'INFO' ('listed by "plugins list"; no module-resolution errors in the gateway log. Snippet: ' + $snippet) }
        else { Add-LabCheck 'probe_plugin' 'INFO' ('listed=' + $listed + ' (exit ' + $pl.ExitCode + '); load-error log lines=' + $loadErr.Count + '. ' + (($pl.Output -split "`r?`n" | Select-Object -First 5) -join ' | ')) }
    }

    if ($Busy) {
        Write-LabSection 'Busy turn (optional)'
        $gw = $healthy[0]
        Add-Type -AssemblyName System.Net.Http
        $handler = New-Object System.Net.Http.HttpClientHandler
        $handler.UseProxy = $false
        $client = New-Object System.Net.Http.HttpClient($handler)
        $client.Timeout = [TimeSpan]::FromSeconds(180)
        $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, ('http://127.0.0.1:' + $gw.Port + '/v1/chat/completions'))
        $req.Headers.Add('Authorization', ('Bearer ' + $gw.Token))
        if ($BusyModel) { $req.Headers.Add('x-openclaw-model', $BusyModel) }
        $body = '{"model":"openclaw/default","user":"lab:l1","messages":[{"role":"user","content":"Reply with the single word OK."}]}'
        $req.Content = New-Object System.Net.Http.StringContent($body, [System.Text.Encoding]::UTF8, 'application/json')
        $bt = New-LabTimer
        $task = $client.SendAsync($req)
        $peakWs = 0.0; $peakPv = 0.0
        while (-not $task.IsCompleted -and $bt.Elapsed.TotalSeconds -lt 180) {
            $m = Get-LabProcessTreeMemory -RootPid $gw.Process.Id
            if ($m.WsMB -gt $peakWs) { $peakWs = $m.WsMB }
            if ($m.PrivateMB -gt $peakPv) { $peakPv = $m.PrivateMB }
            Start-Sleep -Milliseconds 500
        }
        $status = 0
        try { $status = [int]$task.Result.StatusCode } catch { Write-LabInfo (Format-LabError $_) }
        Set-LabValue 'busy_status' $status
        Set-LabValue 'busy_ms' $bt.ElapsedMilliseconds
        Set-LabValue 'busy_peak_ws_mb' $peakWs
        Set-LabValue 'busy_peak_private_mb' $peakPv
        if ($status -eq 200) { Add-LabCheck 'busy_turn' 'PASS' ('HTTP 200 in ' + $bt.ElapsedMilliseconds + ' ms; peak WS ' + $peakWs + ' MB, Private ' + $peakPv + ' MB') }
        else { Add-LabCheck 'busy_turn' 'WARN' ('HTTP ' + $status + ' (provider key/model?); peak WS ' + $peakWs + ' MB') }
        $client.Dispose()
    }
}

Write-LabSection 'Concurrency with other sessions'
$others = @(Get-LabLoopbackListenersInOtherSessions -ProcessNames @('node'))
$otherSessions = @($others | ForEach-Object { $_.SessionId } | Sort-Object -Unique)
foreach ($o in $others) { Write-LabInfo ('node pid ' + $o.Pid + ' session ' + $o.SessionId + ' listens on ' + $o.LocalAddress + ':' + $o.Port) }

if (-not $NoWait -and $healthy.Count -gt 0) {
    Write-Host ''
    Write-Host '>>> Gateways are running. If this is labA: now run L1 -Role Run -BasePort 18920 in labB''s session.'
    Write-Host '>>> Order: wait until labB shows ">>> Gateways are running", press Enter HERE in labA first, then in labB.'
    Write-Host '>>> Press Enter here to stop the gateways and finish.'
    $null = Read-Host
    $others2 = @(Get-LabLoopbackListenersInOtherSessions -ProcessNames @('node'))
    $otherSessions = @(@($otherSessions) + @($others2 | ForEach-Object { $_.SessionId }) | Sort-Object -Unique)
    $stillUp = @($healthy | Where-Object { -not $_.Process.HasExited })
    Set-LabValue 'still_up_at_stop' $stillUp.Count
}
Set-LabValue 'other_sessions_with_node_listeners' ($otherSessions -join ',')
if ($otherSessions.Count -gt 0 -and $ready.Count -gt 0) {
    Add-LabCheck 'concurrent_other_session' 'PASS' ('node loopback listeners seen in session(s) ' + ($otherSessions -join ',') + ' while ours was ready (allow_multi_gateway=' + [bool]$AllowMultiGateway + ')')
} else {
    Add-LabCheck 'concurrent_other_session' 'WARN' 'no gateway seen in another session during this run (expected for the first user; the second user''s run must show PASS here)'
}

Write-LabSection 'Stopping gateways'
foreach ($gw in $gateways) {
    if (-not $gw.Process.HasExited) { Stop-LabProcessTree -RootPid $gw.Process.Id }
    Write-LabInfo ('port ' + $gw.Port + ' stopped')
}

$pkgStampAfter = (Get-Item -LiteralPath $inst.PackageDir).LastWriteTimeUtc
if ($pkgStampAfter -ne $pkgStampBefore) { Add-LabCheck 'package_dir_untouched' 'WARN' 'the OpenClaw package folder timestamp changed during the run' }
else { Add-LabCheck 'package_dir_untouched' 'PASS' 'package folder timestamp unchanged' }
$dotNow = Test-Path -LiteralPath $dotOpenclaw
Set-LabValue 'userprofile_dot_openclaw_created' (($dotNow) -and (-not $dotExistedBefore))
if ($dotNow -and -not $dotExistedBefore) { Add-LabCheck 'state_dir_override_respected' 'WARN' ($dotOpenclaw + ' was created even though OPENCLAW_STATE_DIR was set') }
else { Add-LabCheck 'state_dir_override_respected' 'PASS' 'no new %USERPROFILE%\.openclaw' }

$reasons = @()
if ($ready.Count -lt $Count) { $reasons += ('only ' + $ready.Count + ' of ' + $Count + ' gateways became ready') }
Write-Result -Reasons $reasons
