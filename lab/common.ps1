<#
.SYNOPSIS
    Shared helpers for the Off Manual Desk M1 lab scripts (L1-L10). Dot-source it:
        . (Join-Path $PSScriptRoot 'common.ps1')

.DESCRIPTION
    Works on Windows PowerShell 5.1 (default on Windows Server 2022). No PowerShell 7-only syntax.
    Provides:
      - Start-LabTranscript / Write-Result      transcript in lab\results\<ID>-<COMPUTERNAME>-<timestamp>.txt
                                                and a final "RESULT <ID>: PASS|FAIL|PARTIAL" line
      - Add-LabCheck / Set-LabValue / Write-PasteBlock   checks and key=value values to paste back
      - Get-SessionInfo / Write-SessionInfo     user, SID, session ID, elevation, integrity level
      - timing helpers (New-LabTimer, Get-LabTimestamp)
      - secret helpers that never print secrets (New-LabSecret, Get-LabHashPrefix)
      - error capture (Format-LabError: exception type, HResult, Win32 code)
      - process tree / memory / listening-port helpers
      - HTTP helper that never throws on non-2xx (Invoke-LabHttp)
      - OpenClaw gateway helpers used by L1, L2, L5, L6 (see the OPENCLAW section for doc links)

    Nothing in this file changes system state by itself.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------------------------
$script:LabId          = ''
$script:LabTranscript  = $null
$script:LabValues      = New-Object System.Collections.Specialized.OrderedDictionary
$script:LabChecks      = New-Object System.Collections.ArrayList
$script:LabRoot        = $PSScriptRoot

# ---------------------------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------------------------
function Write-LabSection {
    param([Parameter(Mandatory = $true)][string]$Title)
    Write-Host ''
    Write-Host ('=== ' + $Title + ' ===')
}

function Write-LabInfo {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Message)
    Write-Host ('  ' + $Message)
}

function Write-LabWarn {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host ('  WARNING: ' + $Message)
}

function Get-LabTimestamp {
    # ISO 8601 local time with milliseconds and offset
    return (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz')
}

function New-LabTimer {
    return [System.Diagnostics.Stopwatch]::StartNew()
}

function Measure-LabStep {
    <# Runs a scriptblock and returns @{ Ms; Result; Error } without throwing. #>
    param([Parameter(Mandatory = $true)][scriptblock]$Script)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $result = $null
    $err = $null
    try { $result = & $Script } catch { $err = $_ }
    $sw.Stop()
    return [pscustomobject]@{ Ms = [int]$sw.ElapsedMilliseconds; Result = $result; Error = $err }
}

# ---------------------------------------------------------------------------------------------
# Transcript, checks, values, result
# ---------------------------------------------------------------------------------------------
function Get-LabResultsDir {
    $candidates = @()
    if ($script:LabRoot) { $candidates += (Join-Path $script:LabRoot 'results') }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'OffManualLab\results') }
    $candidates += (Join-Path $env:TEMP 'OffManualLab\results')
    foreach ($dir in $candidates) {
        try {
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            $probe = Join-Path $dir ('.write-test-' + [guid]::NewGuid().ToString('N'))
            [System.IO.File]::WriteAllText($probe, 'x')
            Remove-Item -LiteralPath $probe -Force
            return $dir
        } catch {
            continue
        }
    }
    throw 'No writable results folder found (tried lab\results, %LOCALAPPDATA%\OffManualLab\results, %TEMP%).'
}

function Start-LabTranscript {
    <#
    .SYNOPSIS Starts a transcript at <results>\<Id>-<COMPUTERNAME>-<timestamp>[-<Suffix>].txt and prints the header.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [string]$Suffix = ''
    )
    $script:LabId = $Id
    $script:LabValues.Clear()
    $script:LabChecks.Clear()
    $dir = Get-LabResultsDir
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $name = $Id + '-' + $env:COMPUTERNAME + '-' + $stamp
    if ($Suffix) { $name = $name + '-' + ($Suffix -replace '[^A-Za-z0-9_.-]', '_') }
    $path = Join-Path $dir ($name + '.txt')
    try { Stop-Transcript -ErrorAction Stop | Out-Null } catch { $null = $_ }
    Start-Transcript -Path $path -Force | Out-Null
    $script:LabTranscript = $path
    Write-Host ('#### Off Manual Desk lab ' + $Id + ' started ' + (Get-LabTimestamp))
    Write-Host ('#### Transcript: ' + $path)
    Set-LabValue -Key 'id' -Value $Id
    Set-LabValue -Key 'started' -Value (Get-LabTimestamp)
    return $path
}

function Set-LabValue {
    param(
        [Parameter(Mandatory = $true)][string]$Key,
        [AllowNull()][AllowEmptyString()]$Value
    )
    if ($null -eq $Value) { $Value = '' }
    $text = [string]$Value
    $text = $text -replace "[`r`n]+", ' '
    if ($script:LabValues.Contains($Key)) { $script:LabValues[$Key] = $text } else { $script:LabValues.Add($Key, $text) }
}

function Add-LabCheck {
    <#
    .SYNOPSIS Records one check. Status: PASS, FAIL, WARN, SKIP, INFO. Only PASS/FAIL/WARN/SKIP affect the result.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][ValidateSet('PASS', 'FAIL', 'WARN', 'SKIP', 'INFO')][string]$Status,
        [string]$Detail = ''
    )
    $null = $script:LabChecks.Add([pscustomobject]@{ Name = $Name; Status = $Status; Detail = $Detail })
    $line = '  [' + $Status + '] ' + $Name
    if ($Detail) { $line = $line + ' - ' + $Detail }
    Write-Host $line
}

function Write-PasteBlock {
    <# Prints the clearly delimited key=value block Dwahnil pastes back. #>
    param([string]$Id = $script:LabId)
    Write-Host ''
    Write-Host ('----- BEGIN PASTE ' + $Id + ' -----')
    foreach ($k in $script:LabValues.Keys) {
        Write-Host ($k + '=' + $script:LabValues[$k])
    }
    foreach ($c in $script:LabChecks) {
        $d = ($c.Detail -replace "[`r`n]+", ' ')
        Write-Host ('check.' + ($c.Name -replace '[^A-Za-z0-9_.-]', '_') + '=' + $c.Status + ' | ' + $d)
    }
    Write-Host ('----- END PASTE ' + $Id + ' -----')
}

function Write-Result {
    <#
    .SYNOPSIS Prints the paste block, the final RESULT line, and stops the transcript.
    .PARAMETER Status  PASS, FAIL or PARTIAL. If omitted it is computed from checks:
                       any FAIL -> FAIL; any WARN/SKIP -> PARTIAL; else PASS.
    .PARAMETER Reasons Plain-language reasons printed under the result line.
    #>
    param(
        [ValidateSet('PASS', 'FAIL', 'PARTIAL', '')][string]$Status = '',
        [string[]]$Reasons = @(),
        [string]$Id = $script:LabId
    )
    $fails = @($script:LabChecks | Where-Object { $_.Status -eq 'FAIL' })
    $soft = @($script:LabChecks | Where-Object { $_.Status -eq 'WARN' -or $_.Status -eq 'SKIP' })
    if (-not $Status) {
        if ($fails.Count -gt 0) { $Status = 'FAIL' }
        elseif ($soft.Count -gt 0) { $Status = 'PARTIAL' }
        else { $Status = 'PASS' }
    }
    $allReasons = New-Object System.Collections.ArrayList
    foreach ($r in $Reasons) { if ($r) { $null = $allReasons.Add($r) } }
    foreach ($f in $fails) { $null = $allReasons.Add('FAIL: ' + $f.Name + ' - ' + $f.Detail) }
    foreach ($s in $soft) { $null = $allReasons.Add($s.Status + ': ' + $s.Name + ' - ' + $s.Detail) }
    Set-LabValue -Key 'finished' -Value (Get-LabTimestamp)
    Set-LabValue -Key 'result' -Value $Status
    Write-PasteBlock -Id $Id
    Write-Host ''
    Write-Host ('RESULT ' + $Id + ': ' + $Status)
    foreach ($r in $allReasons) { Write-Host ('  - ' + $r) }
    Write-Host ''
    if ($script:LabTranscript) {
        Write-Host ('Transcript saved to: ' + $script:LabTranscript)
    }
    Write-Host ('Paste the whole output (or the transcript file) back to Claude and type /lab-result ' + ($Id -replace '-.*$', ''))
    try { Stop-Transcript -ErrorAction Stop | Out-Null } catch { $null = $_ }
}

function Write-LabUnhandled {
    <#
    .SYNOPSIS Used by each script's top-level trap: records the unexpected error as a FAIL check and prints the
              paste block + RESULT line so a crash still produces something to paste back.
    #>
    param([Parameter(Mandatory = $true)]$ErrorRecord)
    if (-not $script:LabId) { return }
    $where = ''
    try { $where = ($ErrorRecord.InvocationInfo.ScriptName | Split-Path -Leaf) + ':' + $ErrorRecord.InvocationInfo.ScriptLineNumber } catch { $null = $_ }
    Add-LabCheck 'unhandled_error' 'FAIL' ((Format-LabError $ErrorRecord) + ' at ' + $where)
    Write-Result
    $script:LabId = ''
}

# ---------------------------------------------------------------------------------------------
# Identity / session
# ---------------------------------------------------------------------------------------------
function Get-SessionInfo {
    <# Returns user, SID, session ID, elevation, admin membership, integrity level, OS and PS version. #>
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($id)
    $elevated = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    $adminMember = $false
    $integrity = 'unknown'
    try {
        $groups = (Invoke-LabNative -FilePath "$env:SystemRoot\System32\whoami.exe" -Arguments @('/groups', '/fo', 'csv', '/nh')).Output |
            ConvertFrom-Csv -Header Name, Type, Sid, Attributes
        foreach ($g in $groups) {
            if ($g.Sid -eq 'S-1-5-32-544') { $adminMember = $true }
            switch ($g.Sid) {
                'S-1-16-4096' { $integrity = 'Low' }
                'S-1-16-8192' { $integrity = 'Medium' }
                'S-1-16-8448' { $integrity = 'MediumPlus' }
                'S-1-16-12288' { $integrity = 'High' }
                'S-1-16-16384' { $integrity = 'System' }
            }
        }
    } catch { $null = $_ }
    $os = $null
    try { $os = Get-CimInstance -ClassName Win32_OperatingSystem } catch { $null = $_ }
    $osCaption = ''
    $osBuild = ''
    if ($os) { $osCaption = [string]$os.Caption; $osBuild = [string]$os.BuildNumber }
    return [pscustomobject]@{
        User        = $id.Name
        Sid         = $id.User.Value
        SessionId   = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
        IsElevated  = $elevated
        IsAdminMember = $adminMember
        IsSystem    = ($id.User.Value -eq 'S-1-5-18')
        Integrity   = $integrity
        Computer    = $env:COMPUTERNAME
        OsCaption   = $osCaption
        OsBuild     = $osBuild
        PSVersion   = $PSVersionTable.PSVersion.ToString()
        Pid         = $PID
    }
}

function Write-SessionInfo {
    <# Prints the session info and records it in the paste block. Returns the object. #>
    $s = Get-SessionInfo
    Write-LabSection 'Session'
    Write-LabInfo ('User=' + $s.User + '  SID=' + $s.Sid + '  SessionId=' + $s.SessionId)
    Write-LabInfo ('Elevated=' + $s.IsElevated + '  AdminMember=' + $s.IsAdminMember + '  Integrity=' + $s.Integrity + '  IsSystem=' + $s.IsSystem)
    Write-LabInfo ('Computer=' + $s.Computer + '  OS=' + $s.OsCaption + ' build ' + $s.OsBuild + '  PS=' + $s.PSVersion)
    Set-LabValue 'user' $s.User
    Set-LabValue 'sid' $s.Sid
    Set-LabValue 'session_id' $s.SessionId
    Set-LabValue 'elevated' $s.IsElevated
    Set-LabValue 'admin_member' $s.IsAdminMember
    Set-LabValue 'integrity' $s.Integrity
    Set-LabValue 'computer' $s.Computer
    Set-LabValue 'os' ($s.OsCaption + ' build ' + $s.OsBuild)
    Set-LabValue 'ps_version' $s.PSVersion
    return $s
}

function Assert-LabElevated {
    param([string]$Why = 'this step')
    $s = Get-SessionInfo
    if (-not $s.IsElevated -and -not $s.IsSystem) {
        throw ('Run this from an elevated PowerShell (Run as administrator) for ' + $Why + '.')
    }
}

function Resolve-LabAccountSid {
    param([Parameter(Mandatory = $true)][string]$Account)
    $name = $Account
    if ($name -notmatch '\\') { $name = $env:COMPUTERNAME + '\' + $name }
    try {
        return (New-Object System.Security.Principal.NTAccount($name)).Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        return (New-Object System.Security.Principal.NTAccount($Account)).Translate([System.Security.Principal.SecurityIdentifier]).Value
    }
}

function Get-LabProfilePath {
    <# Profile folder for a SID from HKLM ProfileList (readable by users). $null if the profile does not exist yet. #>
    param([Parameter(Mandatory = $true)][string]$Sid)
    $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $Sid
    if (-not (Test-Path -LiteralPath $key)) { return $null }
    $p = (Get-ItemProperty -LiteralPath $key).ProfileImagePath
    return [Environment]::ExpandEnvironmentVariables([string]$p)
}

function Get-LabUserSessions {
    <# Parses quser.exe. Returns objects UserName, SessionId, State. Empty if quser is not available. #>
    $exe = Join-Path $env:SystemRoot 'System32\quser.exe'
    $out = @()
    if (-not (Test-Path -LiteralPath $exe)) { return $out }
    $r = Invoke-LabNative -FilePath $exe
    if ($r.ExitCode -ne 0) { return $out }
    foreach ($line in ($r.Output | Select-Object -Skip 1)) {
        $t = ([string]$line).TrimStart('>').Trim()
        if (-not $t) { continue }
        $parts = @($t -split '\s+')
        # USERNAME SESSIONNAME ID STATE IDLE LOGON-TIME ; SESSIONNAME may be empty for disconnected sessions
        $idIndex = -1
        for ($i = 1; $i -lt $parts.Count; $i++) { if ($parts[$i] -match '^\d+$') { $idIndex = $i; break } }
        if ($idIndex -lt 0) { continue }
        $state = ''
        if ($parts.Count -gt ($idIndex + 1)) { $state = $parts[$idIndex + 1] }
        $out += [pscustomobject]@{ UserName = $parts[0]; SessionId = [int]$parts[$idIndex]; State = $state }
    }
    return $out
}

# ---------------------------------------------------------------------------------------------
# Native commands. In Windows PowerShell 5.1, "2>&1" on a native exe with $ErrorActionPreference='Stop'
# throws on the first stderr line, so run natives through this helper.
# ---------------------------------------------------------------------------------------------
function Invoke-LabNative {
    <# Runs an exe, returns @{ ExitCode; Output (string[], stdout+stderr) }. Never throws on stderr. #>
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = @()
    $code = -1
    try {
        $out = @(& $FilePath @Arguments 2>&1 | ForEach-Object {
                if ($_ -is [System.Management.Automation.ErrorRecord]) { [string]$_.Exception.Message } else { [string]$_ }
            } | Where-Object { $_ -and $_.Trim() -and $_ -ne 'System.Management.Automation.RemoteException' })
        $code = $LASTEXITCODE
    } catch {
        $out += ('(failed to start ' + $FilePath + ': ' + $_.Exception.Message + ')')
    } finally {
        $ErrorActionPreference = $old
    }
    if ($null -eq $code) { $code = -1 }
    return [pscustomobject]@{ ExitCode = [int]$code; Output = $out }
}

# ---------------------------------------------------------------------------------------------
# Secrets (never printed)
# ---------------------------------------------------------------------------------------------
function New-LabSecret {
    param([int]$Bytes = 32)
    $buf = New-Object byte[] $Bytes
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    try { $rng.GetBytes($buf) } finally { $rng.Dispose() }
    return (($buf | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-LabHashPrefix {
    <# SHA-256 of the UTF-8 text, first 12 hex chars. Use this instead of printing a secret. #>
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))
    } finally { $sha.Dispose() }
    return ('sha256:' + ((($hash | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)))
}

function Get-LabFileHashPrefix {
    param([Parameter(Mandatory = $true)][string]$Path)
    return ('sha256:' + (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.Substring(0, 12).ToLowerInvariant())
}

# ---------------------------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------------------------
function Format-LabError {
    <#
    .SYNOPSIS Turns an ErrorRecord/Exception into a one-line signature:
              type=<.NET type> hresult=0x........ win32=<n or -> msg=<first line>
    #>
    param([Parameter(Mandatory = $true)]$ErrorObject)
    $ex = $ErrorObject
    if ($ex -is [System.Management.Automation.ErrorRecord]) { $ex = $ex.Exception }
    while (($ex -is [System.Management.Automation.MethodInvocationException] -or
            $ex -is [System.Reflection.TargetInvocationException] -or
            $ex -is [System.AggregateException]) -and $null -ne $ex.InnerException) {
        $ex = $ex.InnerException
    }
    $hr = [int]$ex.HResult
    $hrHex = '0x' + $hr.ToString('X8')
    $win32 = '-'
    if ($ex -is [System.ComponentModel.Win32Exception]) {
        $win32 = [string]$ex.NativeErrorCode
    } elseif (($hr -band 0xFFFF0000) -eq 0x80070000) {
        $win32 = [string]($hr -band 0xFFFF)
    }
    $msg = ([string]$ex.Message -split "`r?`n")[0]
    return ('type=' + $ex.GetType().FullName + ' hresult=' + $hrHex + ' win32=' + $win32 + ' msg=' + $msg)
}

# ---------------------------------------------------------------------------------------------
# Processes, memory, ports
# ---------------------------------------------------------------------------------------------
function Get-LabProcessTreeIds {
    <# Root PID plus all descendants (from Win32_Process parent links). #>
    param([Parameter(Mandatory = $true)][int]$RootPid)
    $all = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId)
    $children = @{}
    foreach ($p in $all) {
        $pp = [int]$p.ParentProcessId
        if (-not $children.ContainsKey($pp)) { $children[$pp] = New-Object System.Collections.ArrayList }
        $null = $children[$pp].Add([int]$p.ProcessId)
    }
    $result = New-Object System.Collections.ArrayList
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($RootPid)
    while ($queue.Count -gt 0) {
        $cur = [int]$queue.Dequeue()
        if ($result.Contains($cur)) { continue }
        $null = $result.Add($cur)
        if ($children.ContainsKey($cur)) { foreach ($c in $children[$cur]) { if ($c -ne $cur) { $queue.Enqueue($c) } } }
    }
    return @($result | ForEach-Object { [int]$_ })
}

function Get-LabProcessTreeMemory {
    <#
    .SYNOPSIS Working Set and Private Bytes for each process in the tree, plus totals in MB.
    #>
    param([Parameter(Mandatory = $true)][int]$RootPid)
    $rows = New-Object System.Collections.ArrayList
    foreach ($procId in (Get-LabProcessTreeIds -RootPid $RootPid)) {
        try {
            $p = Get-Process -Id $procId -ErrorAction Stop
            $null = $rows.Add([pscustomobject]@{
                Pid       = $p.Id
                Name      = $p.ProcessName
                WsMB      = [math]::Round($p.WorkingSet64 / 1MB, 1)
                PrivateMB = [math]::Round($p.PrivateMemorySize64 / 1MB, 1)
            })
        } catch { $null = $_ }
    }
    $ws = 0.0; $pv = 0.0
    foreach ($r in $rows) { $ws += $r.WsMB; $pv += $r.PrivateMB }
    return [pscustomobject]@{
        Processes = @($rows)
        Count     = $rows.Count
        WsMB      = [math]::Round($ws, 1)
        PrivateMB = [math]::Round($pv, 1)
    }
}

function Stop-LabProcessTree {
    param([Parameter(Mandatory = $true)][int]$RootPid)
    $ids = @(Get-LabProcessTreeIds -RootPid $RootPid)
    [array]::Reverse($ids)
    foreach ($procId in $ids) {
        try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch { $null = $_ }
    }
}

function Get-LabListeningPorts {
    <# TCP listeners owned by the given PIDs: objects LocalAddress, LocalPort, OwningProcess. #>
    param([Parameter(Mandatory = $true)][int[]]$ProcessIds)
    $out = @()
    try {
        $out = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
                 Where-Object { $ProcessIds -contains [int]$_.OwningProcess } |
                 Select-Object LocalAddress, LocalPort, OwningProcess |
                 Sort-Object LocalPort)
    } catch { $null = $_ }
    return $out
}

function Get-LabLoopbackListenersInOtherSessions {
    <#
    .SYNOPSIS Loopback TCP listeners whose owning process runs in a different session than ours.
              Visible to non-admins (Get-NetTCPConnection + Get-Process SessionId).
    #>
    param([string[]]$ProcessNames = @('node'))
    $mySession = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    $rows = @()
    $listeners = @()
    try { $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop) } catch { return $rows }
    foreach ($l in $listeners) {
        if ($l.LocalAddress -ne '127.0.0.1' -and $l.LocalAddress -ne '::1') { continue }
        $p = $null
        try { $p = Get-Process -Id ([int]$l.OwningProcess) -ErrorAction Stop } catch { continue }
        if ($ProcessNames.Count -gt 0 -and ($ProcessNames -notcontains $p.ProcessName)) { continue }
        if ($p.SessionId -eq $mySession) { continue }
        $rows += [pscustomobject]@{ LocalAddress = $l.LocalAddress; Port = [int]$l.LocalPort; Pid = $p.Id; Name = $p.ProcessName; SessionId = $p.SessionId }
    }
    return @($rows | Sort-Object Port -Unique)
}

function Test-LabTcpPort {
    param([string]$HostName = '127.0.0.1', [Parameter(Mandatory = $true)][int]$Port, [int]$TimeoutMs = 1000)
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $ar = $c.BeginConnect($HostName, $Port, $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $c.EndConnect($ar)
        return $true
    } catch {
        return $false
    } finally {
        $c.Close()
    }
}

# ---------------------------------------------------------------------------------------------
# HTTP (never throws on non-2xx; never sends a proxy for loopback)
# ---------------------------------------------------------------------------------------------
function Invoke-LabHttp {
    <#
    .SYNOPSIS HTTP request returning @{ StatusCode; Body (first 400 chars); Error; Ms }.
              StatusCode 0 means no HTTP response (Error says why).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [string]$Method = 'GET',
        [hashtable]$Headers = @{},
        [string]$Body = '',
        [string]$ContentType = 'application/json',
        [int]$TimeoutSec = 10,
        [System.Text.Encoding]$Encoding = [System.Text.Encoding]::UTF8
    )
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $status = 0
    $text = ''
    $errText = ''
    try {
        $req = [System.Net.HttpWebRequest]::Create($Uri)
        $req.Method = $Method
        $req.Proxy = $null
        $req.Timeout = $TimeoutSec * 1000
        $req.ReadWriteTimeout = $TimeoutSec * 1000
        $req.KeepAlive = $false
        foreach ($k in $Headers.Keys) {
            if ($k -eq 'Content-Type') { $req.ContentType = [string]$Headers[$k] } else { $req.Headers.Add([string]$k, [string]$Headers[$k]) }
        }
        if ($Body) {
            if (-not $req.ContentType) { $req.ContentType = $ContentType }
            $bytes = $Encoding.GetBytes($Body)
            $req.ContentLength = $bytes.Length
            $rs = $req.GetRequestStream()
            $rs.Write($bytes, 0, $bytes.Length)
            $rs.Close()
        }
        $resp = $req.GetResponse()
        $status = [int]$resp.StatusCode
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), $Encoding)
        $text = $sr.ReadToEnd()
        $sr.Close()
        $resp.Close()
    } catch [System.Net.WebException] {
        $we = $_.Exception
        if ($null -ne $we.Response) {
            $status = [int]$we.Response.StatusCode
            try {
                $sr = New-Object System.IO.StreamReader($we.Response.GetResponseStream())
                $text = $sr.ReadToEnd()
                $sr.Close()
            } catch { $null = $_ }
            $we.Response.Close()
        } else {
            $errText = [string]$we.Status + ': ' + $we.Message
        }
    } catch {
        $errText = Format-LabError $_
    }
    $sw.Stop()
    $short = $text
    if ($short.Length -gt 400) { $short = $short.Substring(0, 400) + '...' }
    return [pscustomobject]@{ StatusCode = $status; Body = $short; FullBody = $text; Error = $errText; Ms = [int]$sw.ElapsedMilliseconds }
}

function Wait-LabHttpOk {
    <# Polls a URL until HTTP 200. Returns elapsed ms, or -1 on timeout. #>
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [int]$TimeoutSec = 120,
        [int]$IntervalMs = 250,
        [System.Diagnostics.Stopwatch]$Timer = $null
    )
    if ($null -eq $Timer) { $Timer = [System.Diagnostics.Stopwatch]::StartNew() }
    $deadline = $Timer.ElapsedMilliseconds + ($TimeoutSec * 1000)
    while ($Timer.ElapsedMilliseconds -lt $deadline) {
        $r = Invoke-LabHttp -Uri $Uri -TimeoutSec 2
        if ($r.StatusCode -eq 200) { return [int]$Timer.ElapsedMilliseconds }
        Start-Sleep -Milliseconds $IntervalMs
    }
    return -1
}

# ---------------------------------------------------------------------------------------------
# File helpers
# ---------------------------------------------------------------------------------------------
function Write-LabTextFile {
    <# UTF-8 without BOM. #>
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-LabFileTail {
    param([Parameter(Mandatory = $true)][string]$Path, [int]$Lines = 30)
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    try {
        $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $sr = New-Object System.IO.StreamReader($fs)
        $all = $sr.ReadToEnd()
        $sr.Close()
        $arr = @($all -split "`r?`n")
        if ($arr.Count -le $Lines) { return $arr }
        return $arr[($arr.Count - $Lines)..($arr.Count - 1)]
    } catch {
        return @('(could not read ' + $Path + ': ' + (Format-LabError $_) + ')')
    }
}

function Hide-LabSecretsInText {
    <# Replaces any of the given secret strings in text with their hash prefix (for printing logs). #>
    param([AllowEmptyString()][string]$Text, [string[]]$Secrets = @())
    $t = $Text
    foreach ($s in $Secrets) { if ($s) { $t = $t.Replace($s, '<' + (Get-LabHashPrefix $s) + '>') } }
    return $t
}

# =============================================================================================
# OPENCLAW gateway helpers (L1, L2, L5, L6)
#
# Pinned: OpenClaw 2026.11.6 (commit 06afb10d). Facts below are from docs/OPENCLAW_NOTES.md sections 2-3 (which
# cite docs.openclaw.ai pages and source paths) and were re-read on docs.openclaw.ai on 2026-11-22:
#   - Entry script <prefix>\node_modules\openclaw\openclaw.mjs run with our own node.exe ("install; do not
#     flatten"): https://docs.openclaw.ai/gateway/embedding.md
#   - Run: openclaw gateway run --port <p> --bind loopback --auth token; token from OPENCLAW_GATEWAY_TOKEN:
#     https://docs.openclaw.ai/cli/gateway/running.md
#   - gateway.mode="local" required; config is JSON5 at OPENCLAW_CONFIG_PATH; state at OPENCLAW_STATE_DIR
#     (no --state-dir flag): https://docs.openclaw.ai/help/environment.md, https://docs.openclaw.ai/gateway/configuration.md
#   - Env preset: OPENCLAW_NO_RESPAWN=1, OPENCLAW_DISABLE_BONJOUR=1, OPENCLAW_NO_AUTO_UPDATE=1, DO_NOT_TRACK=1,
#     CLAWHUB_DISABLE_TELEMETRY=1 (source-only), optional OPENCLAW_ALLOW_MULTI_GATEWAY=1. A .env in the CWD is
#     read, so the CWD is set to the state dir: https://docs.openclaw.ai/help/environment.md
#   - Before start: openclaw doctor --fix --yes --non-interactive (exit 0 ok, 1 invalid config/deferred
#     migrations, 2 unparseable): https://docs.openclaw.ai/cli/doctor/running.md, https://docs.openclaw.ai/gateway/embedding.md
#   - Config keys: gateway.auth.rateLimit.exemptLoopback (default true!), gateway.controlUi.enabled,
#     gateway.terminal.enabled (default true), update.checkOnStart, update.auto.enabled, telemetry.enabled,
#     plugins.deny / plugins.load.paths / plugins.entries: https://docs.openclaw.ai/gateway/config-gateway.md,
#     https://docs.openclaw.ai/gateway/config-runtime.md, https://docs.openclaw.ai/tools/plugin.md
#   - Readiness: GET /readyz (unauthenticated; /healthz = liveness only): https://docs.openclaw.ai/gateway/health.md
#   - Derived ports base+1 (MCP Apps), base+2 (browser control), base+9..+110 (CDP):
#     https://docs.openclaw.ai/gateway/multiple-gateways.md
# The secret token is passed by environment variable only, never on a command line or in the config file.
# =============================================================================================
$script:OpenClawPinnedVersion = '2026.11.6'

function Get-LabOpenClawBaseEnv {
    <# Environment applied to every OpenClaw process the lab starts (gateway, doctor, CLI). #>
    param([string]$StateDir = '', [string]$ConfigPath = '', [string]$Token = '', [switch]$AllowMultiGateway)
    $e = [ordered]@{
        OPENCLAW_NO_RESPAWN       = '1'
        OPENCLAW_NO_AUTO_UPDATE   = '1'
        OPENCLAW_DISABLE_BONJOUR  = '1'
        DO_NOT_TRACK              = '1'
        CLAWHUB_DISABLE_TELEMETRY = '1'
    }
    if ($StateDir) { $e['OPENCLAW_STATE_DIR'] = $StateDir }
    if ($ConfigPath) { $e['OPENCLAW_CONFIG_PATH'] = $ConfigPath }
    $e['OPENCLAW_GATEWAY_TOKEN'] = $Token
    if ($AllowMultiGateway) { $e['OPENCLAW_ALLOW_MULTI_GATEWAY'] = '1' } else { $e['OPENCLAW_ALLOW_MULTI_GATEWAY'] = '' }
    return $e
}

function Resolve-OpenClawInstall {
    <#
    .SYNOPSIS Finds node.exe and openclaw.mjs for an install made by L1 -Role Install:
              <Root>\node\node.exe and <Root>\openclaw\node_modules\openclaw\openclaw.mjs (Root = parent of InstallRoot).
              Falls back to node.exe on PATH when <Root>\node is absent.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [string]$NodeExe = ''
    )
    $pkgDir = Join-Path $InstallRoot 'node_modules\openclaw'
    $pkgJson = Join-Path $pkgDir 'package.json'
    if (-not (Test-Path -LiteralPath $pkgJson)) {
        throw ('OpenClaw not found at ' + $pkgDir + '. Run L1-gateway-per-user.ps1 -Role Install first (as labAdmin, elevated).')
    }
    $pkg = Get-Content -LiteralPath $pkgJson -Raw | ConvertFrom-Json
    $entry = Join-Path $pkgDir 'openclaw.mjs'
    if (-not (Test-Path -LiteralPath $entry)) {
        # Fall back to the package.json "bin" field.
        $binProp = $pkg.PSObject.Properties['bin']
        if ($null -eq $binProp) { throw 'openclaw.mjs missing and package.json has no "bin" field.' }
        $binRel = $null
        if ($binProp.Value -is [string]) { $binRel = $binProp.Value }
        else { $named = $binProp.Value.PSObject.Properties['openclaw']; if ($null -ne $named) { $binRel = [string]$named.Value } else { $binRel = [string](@($binProp.Value.PSObject.Properties)[0].Value) } }
        $entry = Join-Path $pkgDir $binRel
    }
    if (-not $NodeExe) {
        $bundled = Join-Path (Split-Path -Parent $InstallRoot) 'node\node.exe'
        if (Test-Path -LiteralPath $bundled) { $NodeExe = $bundled }
        else {
            $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
            if ($null -eq $cmd) { throw 'node.exe not found (no <Root>\node\node.exe and none on PATH). Run L1 -Role Install or pass -NodeExe.' }
            $NodeExe = $cmd.Source
        }
    }
    $nodeVersion = [string]((Invoke-LabNative -FilePath $NodeExe -Arguments @('--version')).Output | Select-Object -First 1)
    return [pscustomobject]@{
        InstallRoot = $InstallRoot
        PackageDir  = $pkgDir
        Entry       = $entry
        Version     = [string]$pkg.version
        NodeExe     = $NodeExe
        NodeVersion = $nodeVersion
    }
}

function New-LabGatewayConfig {
    <#
    .SYNOPSIS Writes <StateDir>\openclaw.json (JSON, valid JSON5) with the hardened minimal config from
              docs/OPENCLAW_NOTES.md. The token is NOT written; it comes from OPENCLAW_GATEWAY_TOKEN.
    .PARAMETER ExemptLoopback        Default $false (rate-limit loopback failures; every RDS user is "loopback").
    .PARAMETER EnableChatCompletions Lab only: turns on /v1/* (used by L1 -Busy).
    .PARAMETER PluginPaths / PluginIds  Lab only: plugins.load.paths and plugins.entries.<id>.enabled=true (L1 -ProbePlugin).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$StateDir,
        [Parameter(Mandatory = $true)][int]$Port,
        [bool]$ExemptLoopback = $false,
        [switch]$EnableChatCompletions,
        [string[]]$PluginPaths = @(),
        [string[]]$PluginIds = @()
    )
    if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
    $gateway = [ordered]@{
        mode      = 'local'
        port      = $Port
        bind      = 'loopback'
        auth      = [ordered]@{ mode = 'token'; rateLimit = [ordered]@{ exemptLoopback = $ExemptLoopback } }
        controlUi = [ordered]@{ enabled = $false }
        terminal  = [ordered]@{ enabled = $false }
    }
    if ($EnableChatCompletions) {
        $gateway['http'] = [ordered]@{ endpoints = [ordered]@{ chatCompletions = [ordered]@{ enabled = $true } } }
    }
    $plugins = [ordered]@{ deny = @('telegram', 'browser', 'device-pair') }
    if ($PluginPaths.Count -gt 0) { $plugins['load'] = [ordered]@{ paths = @($PluginPaths) } }
    if ($PluginIds.Count -gt 0) {
        $entries = [ordered]@{}
        foreach ($id in $PluginIds) { $entries[$id] = [ordered]@{ enabled = $true } }
        $plugins['entries'] = $entries
    }
    $cfg = [ordered]@{
        gateway   = $gateway
        update    = [ordered]@{ checkOnStart = $false; auto = [ordered]@{ enabled = $false } }
        telemetry = [ordered]@{ enabled = $false }
        plugins   = $plugins
        agents    = [ordered]@{ defaults = [ordered]@{ workspace = (Join-Path $StateDir 'workspace') } }
    }
    $path = Join-Path $StateDir 'openclaw.json'
    Write-LabTextFile -Path $path -Text ($cfg | ConvertTo-Json -Depth 10)
    return $path
}

function Invoke-LabOpenClawCli {
    <#
    .SYNOPSIS Runs "node openclaw.mjs <args>" with the lab base environment plus -Environment overrides,
              CWD = -WorkingDirectory (state dir). Returns @{ ExitCode; Output (secrets masked) }.
    #>
    param(
        [Parameter(Mandatory = $true)]$Install,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [System.Collections.IDictionary]$Environment = @{},
        [string]$WorkingDirectory = '',
        [string[]]$Secrets = @(),
        [int]$TimeoutSec = 120
    )
    $base = Get-LabOpenClawBaseEnv
    foreach ($k in $Environment.Keys) { $base[$k] = $Environment[$k] }
    $saved = @{}
    foreach ($k in $base.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
        $v = $base[$k]
        if ($null -eq $v -or [string]$v -eq '') { [Environment]::SetEnvironmentVariable($k, $null, 'Process') }
        else { [Environment]::SetEnvironmentVariable($k, [string]$v, 'Process') }
    }
    if (-not $WorkingDirectory) { $WorkingDirectory = $env:TEMP }
    $tmpOut = [System.IO.Path]::GetTempFileName()
    $tmpErr = [System.IO.Path]::GetTempFileName()
    try {
        $argList = @('"' + $Install.Entry + '"') + $Arguments
        $p = Start-Process -FilePath $Install.NodeExe -ArgumentList $argList -WorkingDirectory $WorkingDirectory `
            -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr -WindowStyle Hidden -PassThru
        if (-not $p.WaitForExit($TimeoutSec * 1000)) {
            Stop-LabProcessTree -RootPid $p.Id
            $code = -999
        } else {
            $code = $p.ExitCode
        }
        $o = Get-Content -LiteralPath $tmpOut -Raw -ErrorAction SilentlyContinue
        $e = Get-Content -LiteralPath $tmpErr -Raw -ErrorAction SilentlyContinue
        $text = ([string]$o + "`n" + [string]$e).Trim()
        $text = Hide-LabSecretsInText -Text $text -Secrets $Secrets
        return [pscustomobject]@{ ExitCode = $code; Output = $text }
    } finally {
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
        Remove-Item -LiteralPath $tmpOut, $tmpErr -Force -ErrorAction SilentlyContinue
    }
}

function Start-LabGateway {
    <#
    .SYNOPSIS Writes the config, runs "doctor --fix --yes --non-interactive" (unless -SkipDoctor), then starts
              "node openclaw.mjs gateway run --port <p> --bind loopback --auth token" as a hidden child of this
              PowerShell (inherits this user's token), CWD = state dir.
              Returns @{ Process; Port; StateDir; Config; StdOut; StdErr; Timer; DoctorExit; DoctorMs; DoctorOutput }.
              Timer starts when the gateway process is launched (after Doctor).
    #>
    param(
        [Parameter(Mandatory = $true)]$Install,
        [Parameter(Mandatory = $true)][string]$StateDir,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$Token,
        [bool]$ExemptLoopback = $false,
        [switch]$EnableChatCompletions,
        [switch]$AllowMultiGateway,
        [switch]$SkipDoctor,
        [string[]]$PluginPaths = @(),
        [string[]]$PluginIds = @(),
        [string[]]$ExtraArgs = @()
    )
    $configPath = New-LabGatewayConfig -StateDir $StateDir -Port $Port -ExemptLoopback $ExemptLoopback `
        -EnableChatCompletions:$EnableChatCompletions -PluginPaths $PluginPaths -PluginIds $PluginIds
    $logDir = Join-Path $StateDir 'lab-logs'
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $out = Join-Path $logDir ('gateway-' + $Port + '-' + $stamp + '.out.log')
    $err = Join-Path $logDir ('gateway-' + $Port + '-' + $stamp + '.err.log')
    $envSet = Get-LabOpenClawBaseEnv -StateDir $StateDir -ConfigPath $configPath -Token $Token -AllowMultiGateway:$AllowMultiGateway

    $doctorExit = $null; $doctorMs = 0; $doctorOut = ''
    if (-not $SkipDoctor) {
        $dsw = [System.Diagnostics.Stopwatch]::StartNew()
        $d = Invoke-LabOpenClawCli -Install $Install -Arguments @('doctor', '--fix', '--yes', '--non-interactive') -Environment $envSet `
            -WorkingDirectory $StateDir -Secrets @($Token) -TimeoutSec 300
        $doctorExit = $d.ExitCode; $doctorMs = [int]$dsw.ElapsedMilliseconds; $doctorOut = $d.Output
        Write-LabTextFile -Path (Join-Path $logDir ('doctor-' + $stamp + '.log')) -Text $d.Output
    }

    $saved = @{}
    foreach ($k in $envSet.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
        $v = $envSet[$k]
        if ($null -eq $v -or [string]$v -eq '') { [Environment]::SetEnvironmentVariable($k, $null, 'Process') }
        else { [Environment]::SetEnvironmentVariable($k, [string]$v, 'Process') }
    }
    try {
        $argList = @('"' + $Install.Entry + '"', 'gateway', 'run', '--port', [string]$Port, '--bind', 'loopback', '--auth', 'token') + $ExtraArgs
        $timer = [System.Diagnostics.Stopwatch]::StartNew()
        $proc = Start-Process -FilePath $Install.NodeExe -ArgumentList $argList -WorkingDirectory $StateDir `
            -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
    } finally {
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    }
    return [pscustomobject]@{
        Process      = $proc
        Port         = $Port
        StateDir     = $StateDir
        Config       = $configPath
        StdOut       = $out
        StdErr       = $err
        Timer        = $timer
        DoctorExit   = $doctorExit
        DoctorMs     = $doctorMs
        DoctorOutput = $doctorOut
    }
}

function Write-LabGatewayLogTail {
    param([Parameter(Mandatory = $true)]$Gateway, [string[]]$Secrets = @(), [int]$Lines = 25)
    foreach ($f in @($Gateway.StdOut, $Gateway.StdErr)) {
        Write-LabInfo ('--- last lines of ' + $f + ' ---')
        foreach ($l in (Get-LabFileTail -Path $f -Lines $Lines)) {
            Write-LabInfo ('| ' + (Hide-LabSecretsInText -Text ([string]$l) -Secrets $Secrets))
        }
    }
}

function Get-LabGatewayListeners {
    <# Every TCP listener of the gateway's process tree (all node PIDs). #>
    param([Parameter(Mandatory = $true)]$Gateway)
    $ids = @(Get-LabProcessTreeIds -RootPid $Gateway.Process.Id)
    return @(Get-LabListeningPorts -ProcessIds $ids)
}
