<#
.SYNOPSIS
    L4 - Can each RDS session's TallyPrime listen for XML on its own port, does company security / TallyVault
    change what the XML port returns, and can another session reach it?

.DESCRIPTION
    Question (docs/LAB_VALIDATION.md L4): Can each session's TallyPrime use its own XML port? Does Tally company
    security affect XML? Feeds ADR-012 and ARCHITECTURE.md section 4 (Tally XML per session 19800-19899).

    TallyPrime is a GUI app, so the setup is manual (below). This script, run in each user's session, does:
      - finds the TallyPrime folder and prints the port/server lines of tally.ini (the setting lives in the
        INSTALL folder, i.e. it is shared by every session that starts the same tally.exe) and whether this
        user can write tally.ini
      - lists running Tally processes per session and the TCP ports each one listens on
      - sends GET / and an XML "Export Collection" request (list of loaded companies) to every Tally listener
        it finds (its own and other sessions'), and records HTTP status, Tally STATUS, company count
        (company names are NOT printed; only a count and hash prefixes)

    Docs:
      - Enable the HTTP/XML server: F1 (Help) > Settings > Connectivity > Client/Server Configuration,
        "TallyPrime acts as" = Server or Both, Port = 9000 (default) or another unused port.
        https://help.tallysolutions.com/xml-integration/ (also "F1 > Settings > Advanced Configuration > Enable
        HTTP Server, default port 9000") and https://help.tallysolutions.com/pre-requisites-for-integrations/
      - Requests: HTTP POST of an XML ENVELOPE with HEADER (VERSION, TALLYREQUEST Export, TYPE Data|Collection|
        Object|Function, ID) and BODY/DESC/STATICVARIABLES; response STATUS 1 = success, 0 = failure.
        https://help.tallysolutions.com/xml-message-formats
      - "Every instance cannot have same port number. However, it can vary if they are executed from different
        folders with different settings, or modified after the instance is executed."
        https://help.tallysolutions.com/article/DeveloperReference/td9/faq/identifying_same_port_.htm (Tally.ERP 9 FAQ)
      - UNVERIFIED - adjust: the inline-TDL collection request below (TYPE Collection, ID OffManualLabCompanies,
        TDL/TDLMESSAGE/COLLECTION TYPE Company FETCH Name) follows the documented envelope but the exact inline
        TDL form was not found on help.tallysolutions.com. A second request uses the plain ID "List of Companies".
        No documented command-line switch to point tally.exe at a different tally.ini was found.

    MANUAL STEPS (do them in this order; type what you see into the -Note parameter or just tell Claude):
      1. labA (RDP session): start TallyPrime (educational mode). Create or open a sample company (e.g. "Lab Co A").
      2. labA: F1 (Help) > Settings > Connectivity > Client/Server Configuration: TallyPrime acts as = Both,
         Port = 19800. Accept (Ctrl+A). If Tally asks to restart, restart it and reopen the company.
      3. labA: run   ...\L4-tally-xml-port.ps1 -Port 19800
      4. labB (second RDP session, labA's Tally still running): start TallyPrime. NOTE any port-conflict message
         (it reads the same tally.ini, which now says 19800). Open a sample company ("Lab Co B").
         Set F1 > Settings > Connectivity > Port = 19801, Accept, restart if asked.
      5. labB: run   ...\L4-tally-xml-port.ps1 -Port 19801        (should see BOTH listeners)
      6. labA: run   ...\L4-tally-xml-port.ps1 -Port 19800        (again; should see both)
      7. labA: close and restart TallyPrime WITHOUT changing settings. Which port does it come up on now
         (tally.ini was last written by labB)? run ...\L4-tally-xml-port.ps1 -Port 19800 -Note 'after labA restart'
      8. Security: labA: Alt+K (Company) > Alter > enable "Use security control" (set an admin user/password), or
         create a company with a TallyVault password. Restart Tally, open the company (enter the password), then
         run ...\L4-tally-xml-port.ps1 -Port 19800 -SecurityLabel security-on
         Also run once with the company NOT opened after restart: -SecurityLabel security-on-not-loaded
      9. Optional: labA: Ctrl+Alt+... lock/close the company and re-run to see what XML returns.

    Pass criteria (measurable):
      - own_port_listening: this session's tally.exe listens on -Port.
      - own_xml: POST to own port returns HTTP 200 and a parseable response (company count recorded).
      - two_sessions: (in step 5 or 6) Tally listeners in >= 2 different sessions on different ports, both
        answering XML -> PASS.
      - cross_session_reachable is recorded (EXPECTED: yes - the XML port has no Windows identity).
      - Security behaviour recorded per -SecurityLabel (company count / STATUS / error text).
      L4 PASS = two_sessions PASS at least once; numbers and security behaviour recorded.

    Leaves behind: nothing from the script. Manual Tally settings (port in tally.ini, company security) stay;
    reset the port to 9000 in F1 > Settings > Connectivity when done. Transcripts in lab\results.
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$TallyDir = '',
    [string]$SecurityLabel = 'off',
    [string]$Note = '',
    [int]$TimeoutSec = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
trap { Write-LabUnhandled $_; break }

$null = Start-LabTranscript -Id 'L4' -Suffix ($env:USERNAME + '-' + $SecurityLabel)
$session = Write-SessionInfo
if ($Port -eq 0) {
    if ($env:USERNAME -ieq 'labA') { $Port = 19800 } elseif ($env:USERNAME -ieq 'labB') { $Port = 19801 } else { $Port = 9000 }
}
Set-LabValue 'expected_port' $Port
Set-LabValue 'security_label' $SecurityLabel
Set-LabValue 'note' $Note

$xmlCollection = @'
<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE>
  <ID>OffManualLabCompanies</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
   </STATICVARIABLES>
   <TDL>
    <TDLMESSAGE>
     <COLLECTION NAME="OffManualLabCompanies" ISMODIFY="No">
      <TYPE>Company</TYPE>
      <FETCH>Name</FETCH>
     </COLLECTION>
    </TDLMESSAGE>
   </TDL>
  </DESC>
 </BODY>
</ENVELOPE>
'@
$xmlListOfCompanies = @'
<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE>
  <ID>List of Companies</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
   </STATICVARIABLES>
  </DESC>
 </BODY>
</ENVELOPE>
'@

function Get-CompanySummary {
    <# Count of <COMPANY ...> elements / NAME values and hash prefixes; never the names themselves. #>
    param([string]$Xml)
    $names = New-Object System.Collections.ArrayList
    foreach ($m in [regex]::Matches($Xml, '<COMPANY\s+NAME="([^"]*)"')) { $null = $names.Add($m.Groups[1].Value) }
    if ($names.Count -eq 0) {
        foreach ($m in [regex]::Matches($Xml, '<NAME[^>]*>([^<]*)</NAME>')) { $null = $names.Add($m.Groups[1].Value) }
    }
    $uniq = @($names | Sort-Object -Unique)
    $status = ''
    $sm = [regex]::Match($Xml, '<STATUS>([^<]*)</STATUS>')
    if ($sm.Success) { $status = $sm.Groups[1].Value }
    $lineErr = ''
    $em = [regex]::Match($Xml, '<LINEERROR>([^<]*)</LINEERROR>')
    if ($em.Success) { $lineErr = $em.Groups[1].Value }
    return [pscustomobject]@{
        Count   = $uniq.Count
        Hashes  = (@($uniq | ForEach-Object { Get-LabHashPrefix $_ }) -join ',')
        Status  = $status
        LineErr = $lineErr
    }
}

Write-LabSection 'TallyPrime install and tally.ini'
$candidates = @()
if ($TallyDir) { $candidates += $TallyDir }
$procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^tally' })
foreach ($p in $procs) { try { if ($p.Path) { $candidates += (Split-Path -Parent $p.Path) } } catch { $null = $_ } }
$candidates += @((Join-Path $env:ProgramFiles 'TallyPrime'), (Join-Path ${env:ProgramFiles(x86)} 'TallyPrime'), 'C:\TallyPrime')
$dir = $null
foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath (Join-Path $c 'tally.ini'))) { $dir = $c; break } }
if ($null -eq $dir) {
    Add-LabCheck 'tally_found' 'FAIL' 'tally.ini not found; pass -TallyDir <folder with tally.exe>'
} else {
    Set-LabValue 'tally_dir' $dir
    $ini = Join-Path $dir 'tally.ini'
    Add-LabCheck 'tally_found' 'PASS' $dir
    $exe = Get-ChildItem -LiteralPath $dir -Filter 'tally*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $exe) { Set-LabValue 'tally_exe_version' $exe.VersionInfo.FileVersion }
    $lines = @(Get-Content -LiteralPath $ini | Where-Object { $_ -match '(?i)port|server|odbc|client' })
    foreach ($l in $lines) { Write-LabInfo ('tally.ini: ' + $l) }
    Set-LabValue 'tally_ini_port_lines' ($lines -join ' ; ')
    Set-LabValue 'tally_ini_mtime' ((Get-Item -LiteralPath $ini).LastWriteTime.ToString('yyyy-MM-ddTHH:mm:ss'))
    $canWrite = $false
    try { $fs = [System.IO.File]::Open($ini, 'Open', 'Write', 'ReadWrite'); $fs.Close(); $canWrite = $true } catch { $null = $_ }
    Set-LabValue 'tally_ini_writable_by_user' $canWrite
    Add-LabCheck 'tally_ini_shared' 'INFO' ('tally.ini is in the install folder (shared by all sessions); writable by ' + $env:USERNAME + '=' + $canWrite)
    $vsIni = Join-Path $env:LOCALAPPDATA 'VirtualStore'
    if (Test-Path -LiteralPath $vsIni) {
        $virt = @(Get-ChildItem -LiteralPath $vsIni -Recurse -Filter 'tally.ini' -ErrorAction SilentlyContinue)
        if ($virt.Count -gt 0) { Add-LabCheck 'tally_ini_virtualstore' 'INFO' ('UAC VirtualStore copy found: ' + $virt[0].FullName + ' (per-user copy!)') ; Set-LabValue 'tally_ini_virtualstore' $virt[0].FullName }
    }
}

Write-LabSection 'Running Tally processes and their listening ports'
$mySession = $session.SessionId
$listeners = New-Object System.Collections.ArrayList
foreach ($p in $procs) {
    $ports = @(Get-LabListeningPorts -ProcessIds @($p.Id))
    $portText = @($ports | ForEach-Object { $_.LocalAddress + ':' + $_.LocalPort }) -join ','
    Write-LabInfo ('pid ' + $p.Id + ' ' + $p.ProcessName + ' session ' + $p.SessionId + ' listens ' + $portText)
    foreach ($x in $ports) { $null = $listeners.Add([pscustomobject]@{ Pid = $p.Id; SessionId = $p.SessionId; Address = [string]$x.LocalAddress; Port = [int]$x.LocalPort }) }
}
Set-LabValue 'tally_processes' (@($procs | ForEach-Object { [string]$_.Id + '@s' + $_.SessionId }) -join ',')
Set-LabValue 'tally_listeners' (@($listeners | ForEach-Object { $_.Address + ':' + $_.Port + '@s' + $_.SessionId }) -join ',')
$mine = @($listeners | Where-Object { $_.SessionId -eq $mySession })
$myOnPort = @($mine | Where-Object { $_.Port -eq $Port })
if (@($procs | Where-Object { $_.SessionId -eq $mySession }).Count -eq 0) { Add-LabCheck 'own_tally_running' 'FAIL' 'TallyPrime is not running in this session' }
elseif ($myOnPort.Count -gt 0) { Add-LabCheck 'own_port_listening' 'PASS' ('listening on ' + $myOnPort[0].Address + ':' + $Port) }
else { Add-LabCheck 'own_port_listening' 'FAIL' ('this session''s Tally listens on: ' + ((@($mine | ForEach-Object { [string]$_.Port })) -join ',') + ' (expected ' + $Port + ')') }

Write-LabSection 'XML requests to every Tally listener'
$answering = New-Object System.Collections.ArrayList
$targets = @($listeners | Sort-Object Port -Unique)
if ($targets.Count -eq 0 -and (Test-LabTcpPort -Port $Port)) { $targets = @([pscustomobject]@{ Pid = 0; SessionId = -1; Address = '127.0.0.1'; Port = $Port }) }
foreach ($t in $targets) {
    $hostName = '127.0.0.1'
    if ($t.Address -ne '0.0.0.0' -and $t.Address -ne '::' -and $t.Address -ne '127.0.0.1') { $hostName = $t.Address }
    $base = 'http://' + $hostName + ':' + $t.Port + '/'
    $tag = 'port' + $t.Port
    $g = Invoke-LabHttp -Uri $base -TimeoutSec $TimeoutSec
    $gBody = ($g.Body -replace '\s+', ' ')
    Set-LabValue ($tag + '.get') ([string]$g.StatusCode + ' ' + $gBody)
    $x1 = Invoke-LabHttp -Uri $base -Method 'POST' -Body $xmlCollection -ContentType 'text/xml' -Headers @{ 'Content-Type' = 'text/xml;charset=utf-8' } -TimeoutSec $TimeoutSec
    $s1 = Get-CompanySummary -Xml $x1.FullBody
    $x2 = Invoke-LabHttp -Uri $base -Method 'POST' -Body $xmlListOfCompanies -Headers @{ 'Content-Type' = 'text/xml;charset=utf-8' } -TimeoutSec $TimeoutSec
    $s2 = Get-CompanySummary -Xml $x2.FullBody
    $who = 'own session'
    if ($t.SessionId -ne $mySession) { $who = 'OTHER session ' + $t.SessionId }
    $d = $who + ': GET=' + $g.StatusCode + '; inlineTDL http=' + $x1.StatusCode + ' status=' + $s1.Status + ' companies=' + $s1.Count + ' err=' + $s1.LineErr +
         '; ListOfCompanies http=' + $x2.StatusCode + ' status=' + $s2.Status + ' companies=' + $s2.Count + ' err=' + $s2.LineErr + ' ' + $x2.Error
    Set-LabValue ($tag + '.session') $t.SessionId
    Set-LabValue ($tag + '.inline_tdl') ('http=' + $x1.StatusCode + ' status=' + $s1.Status + ' companies=' + $s1.Count + ' hashes=' + $s1.Hashes + ' lineerror=' + $s1.LineErr + ' bytes=' + $x1.FullBody.Length)
    Set-LabValue ($tag + '.list_of_companies') ('http=' + $x2.StatusCode + ' status=' + $s2.Status + ' companies=' + $s2.Count + ' lineerror=' + $s2.LineErr + ' bytes=' + $x2.FullBody.Length)
    if ($x1.StatusCode -eq 200 -or $x2.StatusCode -eq 200) {
        $null = $answering.Add($t)
        Add-LabCheck ('xml_' + $tag) 'PASS' $d
    } else {
        Add-LabCheck ('xml_' + $tag) 'FAIL' $d
    }
    if ($x1.StatusCode -eq 200 -and $x1.FullBody.Length -lt 4000) {
        # Short responses are usually errors; show them with company names masked.
        $masked = [regex]::Replace($x1.FullBody, '(<NAME[^>]*>)[^<]*(</NAME>)', '$1***$2')
        $masked = [regex]::Replace($masked, '(<COMPANY\s+NAME=")[^"]*(")', '$1***$2')
        Write-LabInfo ('response (names masked): ' + ($masked -replace '\s+', ' '))
    }
}

$own = @($answering | Where-Object { $_.SessionId -eq $mySession })
if ($own.Count -gt 0) { Add-LabCheck 'own_xml' 'PASS' ('own Tally answers XML on ' + (@($own | ForEach-Object { [string]$_.Port }) -join ',')) }
else { Add-LabCheck 'own_xml' 'FAIL' 'own Tally did not answer XML' }
$otherAns = @($answering | Where-Object { $_.SessionId -ne $mySession })
Set-LabValue 'cross_session_reachable' ($otherAns.Count -gt 0)
if ($otherAns.Count -gt 0) { Add-LabCheck 'cross_session_reachable' 'INFO' ('this user CAN query another session''s Tally on port(s) ' + (@($otherAns | ForEach-Object { [string]$_.Port }) -join ',') + ' (expected: the XML port carries no identity)') }
$sessionsAnswering = @($answering | ForEach-Object { $_.SessionId } | Sort-Object -Unique)
$portsAnswering = @($answering | ForEach-Object { $_.Port } | Sort-Object -Unique)
if ($sessionsAnswering.Count -ge 2 -and $portsAnswering.Count -ge 2) { Add-LabCheck 'two_sessions' 'PASS' ('sessions ' + ($sessionsAnswering -join ',') + ' answer on ports ' + ($portsAnswering -join ',')) }
else { Add-LabCheck 'two_sessions' 'WARN' ('only ' + $sessionsAnswering.Count + ' session(s) answering; run step 5/6 with both Tallys up') }

Write-Result
