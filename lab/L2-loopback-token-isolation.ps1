<#
.SYNOPSIS
    L2 - Is loopback isolation by token real? labB must not be able to use labA's gateway on 127.0.0.1.

.DESCRIPTION
    Question (docs/LAB_VALIDATION.md L2): Is loopback isolation by token real?
    All RDS sessions share 127.0.0.1, so any user can open a TCP connection to any other user's gateway
    port. The gateway token is the only barrier (ARCHITECTURE.md section 2, SECURITY.md).

    Roles (TWO RDP sessions open at the same time):
      -Role Owner     labA, normal PowerShell. Starts a gateway for labA (shared install from L1, hardened config
                      from common.ps1, gateway.auth.rateLimit.exemptLoopback=false unless -ExemptLoopback) on -Port
                      (default 18800) with a fresh random token held only in memory (printed as a hash prefix only).
                      Runs the positive checks (right token works) and baseline negatives, then WAITS for the Intruder.
                      After you press Enter it re-tests the RIGHT token: did labB's failures lock labA out? (rate
                      limiting is keyed by client IP and every session is 127.0.0.1)
      -Role Intruder  labB, normal PowerShell, while the Owner is waiting. Attacks labA's port:
                        unauth GET /health(z) /ready(z) /startup(z) / /api/channels/status /v1/models: status, size,
                               JSON keys; WARN if a body contains user/path/version/secret-like text
                        HTTP  POST /tools/invoke (always on) with no token and a wrong token; /v1/* (disabled) too
                        WS    raw WebSocket connect frame with no auth and a wrong token (a real client also needs an
                              Ed25519 device identity signing connect.challenge - not attempted; refusal is recorded)
                        CLI   openclaw gateway health --port <p> with no token and a wrong token
                        rate  30 wrong-token requests: with exemptLoopback=false a 429 is expected (rate_limited)
                        derived ports: every listener in labA's session at base+1..base+110 (any process): GET / and
                              GET /json/version (Chrome DevTools endpoint) without auth
                        files try to read labA's state dir (profile path from HKLM ProfileList)
                        cmdline try to read labA's node.exe command line via WMI

    Docs (pinned OpenClaw 2026.11.6; docs/OPENCLAW_NOTES.md section 3):
      - Gateway WS auth required by default; token mode: https://docs.openclaw.ai/gateway/security/network-exposure.md
      - gateway.auth.rateLimit.exemptLoopback (default true): https://docs.openclaw.ai/gateway/config-gateway.md
      - Connect frame (type=req, method=connect, params.auth.token, protocol 4), connect.challenge, device identity:
        https://docs.openclaw.ai/gateway/protocol/handshake.md ; https://docs.openclaw.ai/gateway/protocol/auth.md
      - HTTP bearer on /tools/invoke (always enabled): https://docs.openclaw.ai/gateway/tools-invoke-http-api.md
      - /health*, /ready*, /startup* unauthenticated: https://docs.openclaw.ai/gateway/health.md
      - CLI query flags --port, --json; OPENCLAW_GATEWAY_TOKEN for clients:
        https://docs.openclaw.ai/cli/gateway/query.md ; https://docs.openclaw.ai/help/environment.md
      - Derived ports up to base+110: https://docs.openclaw.ai/gateway/multiple-gateways.md
      - UNVERIFIED - adjust: raw WS client.id "cli" (closed enum, OPENCLAW_NOTES.md section 3) / mode "operator";
        a device-less connect is expected to be refused even with the right token. Owner-side WS results are INFO;
        pass/fail uses HTTP + CLI.

    Prerequisites: L1 -Role Install done; labA and labB both logged on over RDP.

    Exact commands:
      labA:  powershell -ExecutionPolicy Bypass -File C:\OffManualLab\lab\L2-loopback-token-isolation.ps1 -Role Owner
             (wait for ">>> Now run the Intruder")
      labB:  powershell -ExecutionPolicy Bypass -File C:\OffManualLab\lab\L2-loopback-token-isolation.ps1 -Role Intruder -TargetPort 18800 -OwnerUser labA
      labA:  press Enter (lockout re-check, then the gateway stops).
      Optional comparison run: labA -Role Owner -ExemptLoopback ; labB -Role Intruder -ExpectRateLimit $false
      Cleanup (each user): ... -Role Cleanup

    What to paste back: both outputs (Owner and Intruder) or lab\results\L2-*.txt, then /lab-result L2.

    Pass criteria (measurable):
      Owner:    /tools/invoke with the right token is not 401/403; without/wrong token 401/403; CLI health with the
                right token exit 0; cross_user_lockout recorded (WARN = another user can lock this user out).
      Intruder: every no-token / wrong-token attempt is refused (HTTP 401/403/429 or 404 for disabled /v1, WS not
                hello-ok, CLI exit != 0); rate_limited PASS (429 seen) with exemptLoopback=false; no unauthenticated
                route leaks user/path/version/secrets; no derived listener answers /json/version with 200;
                labA's state dir is not readable (access denied).
      L2 PASS = Owner PASS and Intruder PASS.

    Leaves behind: %LOCALAPPDATA%\OffManualLab\L2 for each user (gateway state / CLI client state);
    removed by -Role Cleanup. Gateway stopped when the Owner finishes. Transcripts in lab\results.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Owner', 'Intruder', 'Cleanup')][string]$Role,
    [string]$InstallRoot = 'C:\OffManualLab\openclaw',
    [string]$NodeExe = '',
    [int]$Port = 18800,
    [int]$TargetPort = 18800,
    [string]$OwnerUser = 'labA',
    [int]$StartTimeoutSec = 180,
    [int]$RateAttempts = 30,
    [switch]$ExemptLoopback,
    [bool]$ExpectRateLimit = $true,
    [switch]$AllowMultiGateway
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
trap { Write-LabUnhandled $_; break }

$null = Start-LabTranscript -Id 'L2' -Suffix ($Role + '-' + $env:USERNAME)
$session = Write-SessionInfo
Set-LabValue 'role' $Role
$stateRoot = Join-Path $env:LOCALAPPDATA 'OffManualLab\L2'

function Invoke-LabWsConnect {
    <#
    .SYNOPSIS Opens ws://127.0.0.1:<port>, reads the first frame (expects connect.challenge), sends a connect
              request with the given auth object (or none), and classifies the answer:
              ACCEPTED (ok=true hello-ok), REJECTED (ok=false, with error code), CLOSED, NO_CONNECT, TIMEOUT.
    #>
    param([int]$Port, [string]$Token = $null, [switch]$NoAuth)
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $cts = New-Object System.Threading.CancellationTokenSource(15000)
    $outcome = 'UNKNOWN'; $detail = ''; $challenge = $false
    try {
        try {
            $ws.ConnectAsync([Uri]('ws://127.0.0.1:' + $Port + '/'), $cts.Token).GetAwaiter().GetResult()
        } catch {
            return [pscustomobject]@{ Outcome = 'NO_CONNECT'; Challenge = $false; Detail = (Format-LabError $_) }
        }
        $readFrame = {
            $buf = New-Object byte[] 262144
            $ms = New-Object System.IO.MemoryStream
            do {
                $seg = New-Object System.ArraySegment[byte] -ArgumentList @(, $buf)
                $r = $ws.ReceiveAsync($seg, $cts.Token).GetAwaiter().GetResult()
                if ($r.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { return $null }
                $ms.Write($buf, 0, $r.Count)
            } while (-not $r.EndOfMessage)
            return [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
        }
        $first = & $readFrame
        if ($null -eq $first) { return [pscustomobject]@{ Outcome = 'CLOSED'; Challenge = $false; Detail = ('closed before challenge: ' + $ws.CloseStatus + ' ' + $ws.CloseStatusDescription) } }
        if ($first -match '"connect\.challenge"') { $challenge = $true }
        $params = [ordered]@{
            minProtocol = 4; maxProtocol = 4
            client      = [ordered]@{ id = 'cli'; version = '0.0.0-lab'; platform = 'windows'; mode = 'operator' }
            role        = 'operator'
            scopes      = @('operator.read')
            caps        = @(); commands = @(); permissions = @{}
            locale      = 'en-IN'; userAgent = 'offmanual-lab/0.1'
        }
        if (-not $NoAuth) { $params['auth'] = [ordered]@{ token = $Token } }
        $frame = [ordered]@{ type = 'req'; id = 'lab-connect-1'; method = 'connect'; params = $params }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes(($frame | ConvertTo-Json -Depth 8 -Compress))
        $sendSeg = New-Object System.ArraySegment[byte] -ArgumentList @(, $bytes)
        $ws.SendAsync($sendSeg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).GetAwaiter().GetResult()
        for ($n = 0; $n -lt 10; $n++) {
            $msg = $null
            try { $msg = & $readFrame } catch { $outcome = 'CLOSED'; $detail = ('receive failed: ' + (Format-LabError $_) + ' close=' + $ws.CloseStatus + ' ' + $ws.CloseStatusDescription); break }
            if ($null -eq $msg) { $outcome = 'CLOSED'; $detail = ('close=' + $ws.CloseStatus + ' ' + $ws.CloseStatusDescription); break }
            $obj = $null
            try { $obj = $msg | ConvertFrom-Json } catch { continue }
            $idProp = $obj.PSObject.Properties['id']
            if ($null -eq $idProp -or [string]$idProp.Value -ne 'lab-connect-1') { continue }
            $okProp = $obj.PSObject.Properties['ok']
            if ($null -ne $okProp -and $okProp.Value -eq $true) {
                $outcome = 'ACCEPTED'
                $detail = 'hello-ok'
            } else {
                $outcome = 'REJECTED'
                $code = ''
                $errProp = $obj.PSObject.Properties['error']
                if ($null -ne $errProp -and $null -ne $errProp.Value) {
                    $e = $errProp.Value
                    foreach ($name in @('code', 'message')) { $p = $e.PSObject.Properties[$name]; if ($null -ne $p) { $code += ($name + '=' + [string]$p.Value + ' ') } }
                    $dp = $e.PSObject.Properties['details']
                    if ($null -ne $dp -and $null -ne $dp.Value) { $dc = $dp.Value.PSObject.Properties['code']; if ($null -ne $dc) { $code += ('details.code=' + [string]$dc.Value) } }
                }
                $detail = $code.Trim()
            }
            break
        }
        if ($outcome -eq 'UNKNOWN') { $outcome = 'TIMEOUT' }
    } catch {
        $outcome = 'CLOSED'; $detail = (Format-LabError $_)
    } finally {
        try { $ws.Dispose() } catch { $null = $_ }
        $cts.Dispose()
    }
    return [pscustomobject]@{ Outcome = $outcome; Challenge = $challenge; Detail = $detail }
}

function Test-Refused {
    param($HttpResult)
    return ($HttpResult.StatusCode -eq 401 -or $HttpResult.StatusCode -eq 403 -or $HttpResult.StatusCode -eq 429)
}

$wrongToken = New-LabSecret
$toolsBody = '{"tool":"sessions_list","args":{}}'

# ------------------------------------------------------------------------------------------------
if ($Role -eq 'Cleanup') {
    if (Test-Path -LiteralPath $stateRoot) { Remove-Item -LiteralPath $stateRoot -Recurse -Force }
    Add-LabCheck 'remove_state' 'PASS' $stateRoot
    Write-Result
    return
}

# ------------------------------------------------------------------------------------------------
if ($Role -eq 'Owner') {
    if ($session.IsElevated) { Write-LabWarn 'Run the Owner from a normal (non-admin) PowerShell as labA.' }
    $inst = Resolve-OpenClawInstall -InstallRoot $InstallRoot -NodeExe $NodeExe
    Set-LabValue 'openclaw_version' $inst.Version
    Set-LabValue 'port' $Port
    if (Test-LabTcpPort -Port $Port) { Add-LabCheck 'port_free' 'FAIL' ('port ' + $Port + ' already in use'); Write-Result; return }
    $token = New-LabSecret
    Set-LabValue 'token_hash' (Get-LabHashPrefix $token)
    $stateDir = Join-Path $stateRoot ('gw-' + $Port)
    Set-LabValue 'exempt_loopback' ([bool]$ExemptLoopback)
    $gw = Start-LabGateway -Install $inst -StateDir $stateDir -Port $Port -Token $token -ExemptLoopback ([bool]$ExemptLoopback) -AllowMultiGateway:$AllowMultiGateway
    Set-LabValue 'doctor' ('exit ' + $gw.DoctorExit + ' in ' + $gw.DoctorMs + ' ms')
    $ms = Wait-LabHttpOk -Uri ('http://127.0.0.1:' + $Port + '/healthz') -TimeoutSec $StartTimeoutSec -Timer $gw.Timer
    Set-LabValue 'health_ms' $ms
    if ($ms -lt 0) {
        Add-LabCheck 'gateway_up' 'FAIL' 'no /healthz 200'
        Write-LabGatewayLogTail -Gateway $gw -Secrets @($token)
        Stop-LabProcessTree -RootPid $gw.Process.Id
        Write-Result; return
    }
    $readyMs = Wait-LabHttpOk -Uri ('http://127.0.0.1:' + $Port + '/readyz') -TimeoutSec 90 -Timer $gw.Timer
    Set-LabValue 'ready_ms' $readyMs
    Add-LabCheck 'gateway_up' 'PASS' ('healthz ' + $ms + ' ms, readyz ' + $readyMs + ' ms, pid ' + $gw.Process.Id + ', exemptLoopback=' + [bool]$ExemptLoopback)

    $base = 'http://127.0.0.1:' + $Port
    Write-LabSection 'Positive checks (right token, own session)'
    $r = Invoke-LabHttp -Uri ($base + '/tools/invoke') -Method 'POST' -Body $toolsBody -Headers @{ Authorization = ('Bearer ' + $token) }
    Set-LabValue 'owner_tools_invoke_status' $r.StatusCode
    if ($r.StatusCode -ne 0 -and -not (Test-Refused $r)) { Add-LabCheck 'http_tools_invoke_right_token' 'PASS' ('status ' + $r.StatusCode + ' (token accepted)') }
    else { Add-LabCheck 'http_tools_invoke_right_token' 'FAIL' ('status ' + $r.StatusCode + ' ' + $r.Error) }

    $cliEnv = Get-LabOpenClawBaseEnv -StateDir $stateDir -ConfigPath (Join-Path $stateDir 'openclaw.json') -Token $token -AllowMultiGateway:$AllowMultiGateway
    $cli = Invoke-LabOpenClawCli -Install $inst -Arguments @('gateway', 'health', '--port', [string]$Port, '--json') -Environment $cliEnv -WorkingDirectory $stateDir -Secrets @($token) -TimeoutSec 90
    Set-LabValue 'owner_cli_health_exit' $cli.ExitCode
    if ($cli.ExitCode -eq 0) { Add-LabCheck 'cli_health_right_token' 'PASS' 'exit 0' }
    else { Add-LabCheck 'cli_health_right_token' 'FAIL' ('exit ' + $cli.ExitCode + ': ' + ($cli.Output -replace "`r?`n", ' | ')) }

    $w = Invoke-LabWsConnect -Port $Port -Token $token
    Set-LabValue 'owner_ws_right_token' ($w.Outcome + ' ' + $w.Detail)
    Add-LabCheck 'ws_right_token_device_less' 'INFO' ('challenge=' + $w.Challenge + ' outcome=' + $w.Outcome + ' ' + $w.Detail)

    Write-LabSection 'Baseline negatives (own session)'
    $r = Invoke-LabHttp -Uri ($base + '/tools/invoke') -Method 'POST' -Body $toolsBody
    if (Test-Refused $r) { Add-LabCheck 'own_http_no_token_refused' 'PASS' ([string]$r.StatusCode) } else { Add-LabCheck 'own_http_no_token_refused' 'FAIL' ([string]$r.StatusCode) }
    $r = Invoke-LabHttp -Uri ($base + '/tools/invoke') -Method 'POST' -Body $toolsBody -Headers @{ Authorization = ('Bearer ' + $wrongToken) }
    if (Test-Refused $r) { Add-LabCheck 'own_http_wrong_token_refused' 'PASS' ([string]$r.StatusCode) } else { Add-LabCheck 'own_http_wrong_token_refused' 'FAIL' ([string]$r.StatusCode) }

    $ids = @(Get-LabProcessTreeIds -RootPid $gw.Process.Id)
    $ports = @(Get-LabListeningPorts -ProcessIds $ids)
    Set-LabValue 'owner_listening' (@($ports | ForEach-Object { $_.LocalAddress + ':' + $_.LocalPort }) -join ',')
    Write-LabInfo ('Listening: ' + (@($ports | ForEach-Object { $_.LocalAddress + ':' + $_.LocalPort }) -join ', '))

    Write-Host ''
    Write-Host ('>>> Now run the Intruder in labB''s session:  ...\L2-loopback-token-isolation.ps1 -Role Intruder -TargetPort ' + $Port + ' -OwnerUser ' + $env:USERNAME)
    Write-Host '>>> Press Enter here when the Intruder has printed its RESULT line.'
    $null = Read-Host
    # Rate limiting is keyed by client IP; every RDS session is 127.0.0.1. Did the intruder's failures lock US out?
    $after = Invoke-LabHttp -Uri ($base + '/tools/invoke') -Method 'POST' -Body $toolsBody -Headers @{ Authorization = ('Bearer ' + $token) } -TimeoutSec 30
    Set-LabValue 'owner_right_token_after_intruder' ([string]$after.StatusCode + ' in ' + $after.Ms + ' ms')
    if ($after.StatusCode -eq 429) { Add-LabCheck 'cross_user_lockout' 'WARN' ('the RIGHT token got 429 after the intruder''s failures: another user can lock this user out (shared loopback rate-limit key)') }
    elseif ($after.StatusCode -ne 0 -and -not (Test-Refused $after)) { Add-LabCheck 'cross_user_lockout' 'PASS' ('right token still accepted after the intruder (status ' + $after.StatusCode + ', ' + $after.Ms + ' ms)') }
    else { Add-LabCheck 'cross_user_lockout' 'WARN' ('right token after intruder: status ' + $after.StatusCode + ' ' + $after.Error) }
    $alive = -not $gw.Process.HasExited
    if ($alive) { Add-LabCheck 'gateway_survived_intruder' 'PASS' 'gateway still running after the Intruder' }
    else { Add-LabCheck 'gateway_survived_intruder' 'WARN' ('gateway exited, code ' + $gw.Process.ExitCode) }
    Stop-LabProcessTree -RootPid $gw.Process.Id
    Write-Result
    return
}

# ------------------------------------------------------------------------------------------------
# Intruder
if ($session.IsElevated) { Write-LabWarn 'Run the Intruder from a normal (non-admin) PowerShell as labB.' }
Set-LabValue 'target_port' $TargetPort
Set-LabValue 'owner_user' $OwnerUser
$base = 'http://127.0.0.1:' + $TargetPort

Write-LabSection 'Discovery: node loopback listeners in other sessions'
$others = @(Get-LabLoopbackListenersInOtherSessions -ProcessNames @('node'))
foreach ($o in $others) { Write-LabInfo ('pid ' + $o.Pid + ' session ' + $o.SessionId + ' port ' + $o.Port) }
Set-LabValue 'other_session_node_ports' (@($others | ForEach-Object { [string]$_.Port }) -join ',')
$target = @($others | Where-Object { $_.Port -eq $TargetPort })
if ($target.Count -eq 0) {
    if (Test-LabTcpPort -Port $TargetPort) { Add-LabCheck 'target_found' 'WARN' 'port open but not owned by a node.exe in another session' }
    else { Add-LabCheck 'target_found' 'FAIL' ('nothing listens on ' + $TargetPort + '; is the Owner waiting?'); Write-Result; return }
} else {
    Add-LabCheck 'target_found' 'PASS' ('node pid ' + $target[0].Pid + ' in session ' + $target[0].SessionId)
}

Write-LabSection 'Unauthenticated routes: what do they reveal?'
# Probes are unauthenticated by design (https://docs.openclaw.ai/gateway/health.md); "local" /readyz callers may get
# detailed responses - and on RDS every session is local. Flag anything beyond readiness (paths, user, version, secrets).
$leakPattern = '(?i)(\\Users\\|AppData|' + [regex]::Escape($OwnerUser) + '|"version"|sk-[a-z0-9]|token|password|sessionKey|\\\\[a-z0-9-]+\\)'
foreach ($path in @('/health', '/healthz', '/ready', '/readyz', '/startup', '/startupz', '/', '/api/channels/status', '/v1/models')) {
    $r = Invoke-LabHttp -Uri ($base + $path) -TimeoutSec 10
    $keys = ''
    try { $j = $r.FullBody | ConvertFrom-Json; if ($null -ne $j) { $keys = (@($j.PSObject.Properties | ForEach-Object { $_.Name }) -join ',') } } catch { $null = $_ }
    $d = 'status ' + $r.StatusCode + ', ' + $r.FullBody.Length + ' bytes' + $(if ($keys) { ', keys: ' + $keys } else { '' })
    Set-LabValue ('unauth' + ($path -replace '[^A-Za-z0-9]', '_')) $d
    $isProbe = $path -match '^/(health|healthz|ready|readyz|startup|startupz)$'
    if ($r.FullBody -match $leakPattern) { Add-LabCheck ('unauth' + ($path -replace '[^A-Za-z0-9]', '_')) 'WARN' ($d + ' - body contains user/path/version/secret-like text: ' + $Matches[0]) }
    elseif (-not $isProbe -and $r.StatusCode -ge 200 -and $r.StatusCode -lt 300 -and $r.FullBody.Length -gt 0) { Add-LabCheck ('unauth' + ($path -replace '[^A-Za-z0-9]', '_')) 'WARN' ($d + ' - non-probe route answered 2xx without auth') }
    else { Add-LabCheck ('unauth' + ($path -replace '[^A-Za-z0-9]', '_')) 'INFO' $d }
}

Write-LabSection 'HTTP with no / wrong token'
$cases = @(
    @{ Name = 'http_tools_invoke_no_token'; Uri = '/tools/invoke'; Method = 'POST'; Body = $toolsBody; Headers = @{} },
    @{ Name = 'http_tools_invoke_wrong_token'; Uri = '/tools/invoke'; Method = 'POST'; Body = $toolsBody; Headers = @{ Authorization = ('Bearer ' + $wrongToken) } },
    @{ Name = 'http_models_wrong_token'; Uri = '/v1/models'; Method = 'GET'; Body = ''; Headers = @{ Authorization = ('Bearer ' + $wrongToken) } },
    @{ Name = 'http_chat_no_token'; Uri = '/v1/chat/completions'; Method = 'POST'; Body = '{"model":"openclaw/default","messages":[{"role":"user","content":"hi"}]}'; Headers = @{} }
)
foreach ($c in $cases) {
    $r = Invoke-LabHttp -Uri ($base + $c.Uri) -Method $c.Method -Body $c.Body -Headers $c.Headers
    $d = 'status ' + $r.StatusCode + ' in ' + $r.Ms + ' ms'
    if ($r.Error) { $d += ' err ' + $r.Error }
    if (Test-Refused $r) { Add-LabCheck $c.Name 'PASS' $d }
    elseif ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) { Add-LabCheck $c.Name 'FAIL' ($d + ' - ACCEPTED without the right token') }
    elseif ($r.StatusCode -eq 404 -and $c.Uri -like '/v1/*') { Add-LabCheck $c.Name 'PASS' ($d + ' (/v1/* disabled in this config)') }
    else { Add-LabCheck $c.Name 'WARN' ($d + ' - not a clear 401/403') }
}

Write-LabSection 'WebSocket (raw connect frame)'
$w = Invoke-LabWsConnect -Port $TargetPort -NoAuth
if ($w.Outcome -eq 'ACCEPTED') { Add-LabCheck 'ws_no_auth' 'FAIL' 'hello-ok without any token' } else { Add-LabCheck 'ws_no_auth' 'PASS' ('challenge=' + $w.Challenge + ' ' + $w.Outcome + ' ' + $w.Detail) }
$w = Invoke-LabWsConnect -Port $TargetPort -Token $wrongToken
if ($w.Outcome -eq 'ACCEPTED') { Add-LabCheck 'ws_wrong_token' 'FAIL' 'hello-ok with a wrong token' } else { Add-LabCheck 'ws_wrong_token' 'PASS' ($w.Outcome + ' ' + $w.Detail) }

Write-LabSection 'OpenClaw CLI as client'
$inst = $null
try { $inst = Resolve-OpenClawInstall -InstallRoot $InstallRoot -NodeExe $NodeExe } catch { Add-LabCheck 'cli_available' 'SKIP' (Format-LabError $_) }
if ($null -ne $inst) {
    $clientState = Join-Path $stateRoot 'cli-client'
    if (-not (Test-Path -LiteralPath $clientState)) { New-Item -ItemType Directory -Path $clientState -Force | Out-Null }
    $envNo = Get-LabOpenClawBaseEnv -StateDir $clientState -ConfigPath (Join-Path $clientState 'openclaw.json') -Token ''
    $cli = Invoke-LabOpenClawCli -Install $inst -Arguments @('gateway', 'health', '--port', [string]$TargetPort, '--json') -Environment $envNo -WorkingDirectory $clientState -TimeoutSec 90
    if ($cli.ExitCode -ne 0) { Add-LabCheck 'cli_no_token' 'PASS' ('exit ' + $cli.ExitCode) } else { Add-LabCheck 'cli_no_token' 'FAIL' 'exit 0 without a token' }
    Set-LabValue 'cli_no_token_output' (($cli.Output -replace "`r?`n", ' | '))
    $envWrong = Get-LabOpenClawBaseEnv -StateDir $clientState -ConfigPath (Join-Path $clientState 'openclaw.json') -Token $wrongToken
    $cli = Invoke-LabOpenClawCli -Install $inst -Arguments @('gateway', 'health', '--port', [string]$TargetPort, '--json') -Environment $envWrong -WorkingDirectory $clientState -Secrets @($wrongToken) -TimeoutSec 90
    if ($cli.ExitCode -ne 0) { Add-LabCheck 'cli_wrong_token' 'PASS' ('exit ' + $cli.ExitCode) } else { Add-LabCheck 'cli_wrong_token' 'FAIL' 'exit 0 with a wrong token' }
    Set-LabValue 'cli_wrong_token_output' (($cli.Output -replace "`r?`n", ' | '))
}

Write-LabSection ('Rate: ' + $RateAttempts + ' wrong-token requests (owner config exemptLoopback=' + (-not $ExpectRateLimit) + ' expected)')
# gateway.auth.rateLimit.exemptLoopback defaults to TRUE; the lab config sets false (docs/OPENCLAW_NOTES.md section 3,
# https://docs.openclaw.ai/gateway/config-gateway.md). With false, repeated failures from 127.0.0.1 should get 429.
$lat = @(); $codes = @(); $first429 = -1
for ($i = 0; $i -lt $RateAttempts; $i++) {
    $r = Invoke-LabHttp -Uri ($base + '/tools/invoke') -Method 'POST' -Body $toolsBody -Headers @{ Authorization = ('Bearer ' + (New-LabSecret)) } -TimeoutSec 30
    $lat += $r.Ms; $codes += $r.StatusCode
    if ($r.StatusCode -eq 429 -and $first429 -lt 0) { $first429 = $i + 1 }
}
Set-LabValue 'rate_latency_ms' ($lat -join ',')
Set-LabValue 'rate_status_codes' ($codes -join ',')
Set-LabValue 'rate_first_429_at_attempt' $first429
$accepted = @($codes | Where-Object { $_ -ge 200 -and $_ -lt 300 })
$summary = 'first ' + $lat[0] + ' ms, last ' + $lat[-1] + ' ms, max ' + (($lat | Measure-Object -Maximum).Maximum) + ' ms; first 429 at attempt ' + $first429
if ($accepted.Count -gt 0) { Add-LabCheck 'rate_wrong_tokens' 'FAIL' 'a random token was accepted' }
elseif ($ExpectRateLimit -and $first429 -gt 0) { Add-LabCheck 'rate_limited' 'PASS' ('wrong tokens from another session are rate limited; ' + $summary) }
elseif ($ExpectRateLimit) { Add-LabCheck 'rate_limited' 'WARN' ('no 429 although exemptLoopback=false was expected; ' + $summary) }
else { Add-LabCheck 'rate_limited' 'INFO' ('exemptLoopback=true run: ' + $summary) }
Write-LabInfo 'After this RESULT line, press Enter in the Owner window: it checks whether these failures locked out the RIGHT token (cross_user_lockout).'

Write-LabSection 'Other listeners of the owner''s node processes (derived ports)'
# Derived ports reach base+110 and may be owned by node, chrome or msedge (browser control / CDP), so scan every
# process in the owner's session within TargetPort+1 .. TargetPort+110.
$extra = @()
if ($target.Count -gt 0) {
    $ownerSession = $target[0].SessionId
    $extra = @(Get-LabLoopbackListenersInOtherSessions -ProcessNames @() |
               Where-Object { $_.SessionId -eq $ownerSession -and $_.Port -gt $TargetPort -and $_.Port -le ($TargetPort + 110) })
}
Set-LabValue 'derived_ports_seen' (@($extra | ForEach-Object { $_.Name + ':' + $_.Port }) -join ',')
if ($extra.Count -eq 0) { Add-LabCheck 'derived_ports' 'INFO' 'no other loopback listeners in base+1..base+110 in the owner''s session (browser tool not started)' }
foreach ($e in $extra) {
    $root = Invoke-LabHttp -Uri ('http://127.0.0.1:' + $e.Port + '/') -TimeoutSec 5
    $cdp = Invoke-LabHttp -Uri ('http://127.0.0.1:' + $e.Port + '/json/version') -TimeoutSec 5
    $d = 'GET / = ' + $root.StatusCode + ', GET /json/version = ' + $cdp.StatusCode
    if ($cdp.StatusCode -eq 200 -and $cdp.Body -match 'webSocketDebuggerUrl|Browser') { Add-LabCheck ('derived_port_' + $e.Port) 'FAIL' ($d + ' - DevTools endpoint reachable from another session without auth') }
    elseif ($root.StatusCode -ge 200 -and $root.StatusCode -lt 300) { Add-LabCheck ('derived_port_' + $e.Port) 'WARN' ($d + ' - answers without auth; check what it is') }
    else { Add-LabCheck ('derived_port_' + $e.Port) 'PASS' $d }
}

Write-LabSection 'Owner''s files and command line'
try {
    $ownerSid = Resolve-LabAccountSid -Account $OwnerUser
    $ownerProfile = Get-LabProfilePath -Sid $ownerSid
    Set-LabValue 'owner_sid' $ownerSid
    if ($ownerProfile) {
        $ownerState = Join-Path $ownerProfile 'AppData\Local\OffManualLab\L2'
        try {
            $items = @(Get-ChildItem -LiteralPath $ownerState -Recurse -ErrorAction Stop)
            Add-LabCheck 'owner_state_unreadable' 'FAIL' ('listed ' + $items.Count + ' items in the owner''s state dir')
        } catch {
            Add-LabCheck 'owner_state_unreadable' 'PASS' (Format-LabError $_)
        }
    } else { Add-LabCheck 'owner_state_unreadable' 'SKIP' 'owner profile not found in ProfileList' }
} catch { Add-LabCheck 'owner_state_unreadable' 'SKIP' (Format-LabError $_) }
if ($target.Count -gt 0) {
    $cim = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + $target[0].Pid) -ErrorAction SilentlyContinue
    $cmdLine = ''
    if ($null -ne $cim -and $null -ne $cim.CommandLine) { $cmdLine = [string]$cim.CommandLine }
    if ($cmdLine) { Add-LabCheck 'owner_cmdline_hidden' 'WARN' 'the owner''s node.exe command line is readable by this user (keep tokens out of command lines)' }
    else { Add-LabCheck 'owner_cmdline_hidden' 'PASS' 'command line not readable' }
}

Write-Result
