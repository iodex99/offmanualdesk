<#
.SYNOPSIS
    L10 - Does a DPAPI CurrentUser secret survive logoff/logon, is it unreadable by another user, and what does
    LocalMachine scope really protect against?

.DESCRIPTION
    Question (docs/LAB_VALIDATION.md L10): DPAPI CurrentUser survives logoff/logon (local and FSLogix profiles);
    machine scope readable by service only? Feeds ARCHITECTURE.md section 2 (gateway token DPAPI CurrentUser),
    ADR-006 / ADR-011 (TOTP secrets and LLM key DPAPI machine scope).

    Phases (in this order):
      1. -Phase MachineProtect  labAdmin, ELEVATED. Creates C:\OffManualLab\shared\L10 (Users Modify - lab only).
                                Protects a random secret with DataProtectionScope.LocalMachine + random entropy and
                                writes: machine-open.bin (readable by Users), machine-acl.bin (ACL: SYSTEM + Admins
                                only), machine-entropy.bin (readable by Users - simulates an attacker who knows the
                                entropy, e.g. because it is embedded in our binary), machine.sha256prefix.
      2. -Phase Protect         labA. Protects a random secret with DataProtectionScope.CurrentUser into
                                %LOCALAPPDATA%\OffManualLab\L10\currentuser.bin (+ .sha256prefix with a hash prefix of
                                the secret, never the secret) and copies the blob to the shared folder for labB.
                                Records profile type (local / roaming / FSLogix) and DPAPI master-key folder presence.
      3. labA SIGNS OUT and signs in again (a real logoff, not a disconnect).
      4. -Phase Verify          labA. Decrypts its blob; checks the hash prefix; checks a logon really happened since
                                Protect (explorer.exe start time).
      5. -Phase CrossUser       labB. Tries to decrypt labA's CurrentUser blob (must FAIL). Tries the LocalMachine blob
                                with the entropy (EXPECTED TO SUCCEED - that is the point) and without it, and tries to
                                read the SYSTEM-only copy (must be access denied).
      6. -Phase Cleanup         each user removes %LOCALAPPDATA%\OffManualLab\L10; labAdmin (elevated) removes
                                C:\OffManualLab\shared\L10.
      Dev-box smoke test: -Phase Protect then -Phase Verify in the same session (Verify reports no re-logon).

    IMPORTANT expected finding: LocalMachine-scope DPAPI blobs can be decrypted by ANY process on the machine (any
    user) that can read the blob (and knows the optional entropy). Machine-scope secrets (TOTP secrets, firm LLM key)
    must therefore ALSO be protected by file ACLs (SYSTEM only) - DPAPI machine scope alone does not mean "service only".
      ProtectedData / DataProtectionScope: https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata
        https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.dataprotectionscope
        ("LocalMachine: The protected data is associated with the machine context. Any process running on the computer
        can unprotect data.")
      CryptProtectData (CRYPTPROTECT_LOCAL_MACHINE): https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata
    FSLogix: optional. If FSLogix profile containers are configured (HKLM\SOFTWARE\FSLogix\Profiles Enabled=1) the
    profile type is recorded so the same Protect/Verify run covers that case; otherwise it is reported as not present.

    Exact commands:
      labAdmin (elevated): ...\L10-dpapi.ps1 -Phase MachineProtect
      labA:                ...\L10-dpapi.ps1 -Phase Protect
      labA:                sign out, sign in
      labA:                ...\L10-dpapi.ps1 -Phase Verify
      labB:                ...\L10-dpapi.ps1 -Phase CrossUser -OwnerUser labA
      cleanup:             each user ...\L10-dpapi.ps1 -Phase Cleanup ; labAdmin (elevated) ...\L10-dpapi.ps1 -Phase Cleanup -Shared
    (Optional, before cleanup) labAdmin: L5 -Role Run reports whether the S4U / password tasks can decrypt labA's
    currentuser.bin (dpapi_l10_blob) - DPAPI CurrentUser inside a logged-off task.

    What to paste back: every phase's output (lab\results\L10-*.txt), then /lab-result L10.

    Pass criteria (measurable):
      - protect_roundtrip PASS (Protect).
      - verify_after_relogon PASS: decrypted, hash prefix matches, and relogon_since_protect = True (Verify).
      - crossuser_currentuser_refused PASS: labB's Unprotect throws CryptographicException (HResult recorded).
      - machine_acl_copy_unreadable PASS: labB gets access denied on machine-acl.bin.
      - machine_scope_readable_by_other_user recorded (EXPECTED True with entropy, False without entropy).
      L10 PASS = all PASS items above; the machine-scope finding is recorded either way.

    Leaves behind until -Phase Cleanup: %LOCALAPPDATA%\OffManualLab\L10 (labA, labB), C:\OffManualLab\shared\L10.
    Transcripts in lab\results. No secret is ever printed (hash prefixes only).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('MachineProtect', 'Protect', 'Verify', 'CrossUser', 'Cleanup')][string]$Phase,
    [string]$OwnerUser = 'labA',
    [string]$SharedDir = 'C:\OffManualLab\shared\L10',
    [switch]$Shared
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
trap { Write-LabUnhandled $_; break }
Add-Type -AssemblyName System.Security

$null = Start-LabTranscript -Id 'L10' -Suffix ($Phase + '-' + $env:USERNAME)
$s = Write-SessionInfo
Set-LabValue 'phase' $Phase
$userDir = Join-Path $env:LOCALAPPDATA 'OffManualLab\L10'
$blobPath = Join-Path $userDir 'currentuser.bin'
$hashPath = $blobPath + '.sha256prefix'
$stampPath = Join-Path $userDir 'protected-at.txt'
$CU = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$LM = [System.Security.Cryptography.DataProtectionScope]::LocalMachine

function Get-ProfileType {
    $info = [ordered]@{}
    $info['profile_path'] = $env:USERPROFILE
    $fsl = $false
    try {
        $k = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\FSLogix\Profiles' -ErrorAction Stop
        $en = $k.PSObject.Properties['Enabled']
        if ($null -ne $en -and [int]$en.Value -eq 1) { $fsl = $true }
    } catch { $null = $_ }
    $info['fslogix_enabled'] = $fsl
    $svc = Get-Service -Name frxsvc -ErrorAction SilentlyContinue
    $info['fslogix_service'] = $(if ($null -ne $svc) { [string]$svc.Status } else { 'absent' })
    try {
        $up = Get-CimInstance -ClassName Win32_UserProfile -Filter ("SID='" + $s.Sid + "'") -ErrorAction Stop
        if ($null -ne $up) {
            $info['roaming_configured'] = [bool]$up.RoamingConfigured
            $info['profile_status'] = [int]$up.Status   # 1=temporary 2=roaming 4=mandatory 8=corrupted
        }
    } catch { $null = $_ }
    $mk = Join-Path $env:APPDATA ('Microsoft\Protect\' + $s.Sid)
    $info['dpapi_masterkey_folder_exists'] = (Test-Path -LiteralPath $mk)
    if (Test-Path -LiteralPath $mk) { $info['dpapi_masterkey_files'] = @(Get-ChildItem -LiteralPath $mk -Force -ErrorAction SilentlyContinue).Count }
    return $info
}

# ------------------------------------------------------------------------------------------------
if ($Phase -eq 'Cleanup') {
    if (Test-Path -LiteralPath $userDir) { Remove-Item -LiteralPath $userDir -Recurse -Force; Add-LabCheck 'remove_user_dir' 'PASS' $userDir } else { Add-LabCheck 'remove_user_dir' 'PASS' 'nothing to remove' }
    if ($Shared) {
        Assert-LabElevated -Why 'removing the shared folder'
        if (Test-Path -LiteralPath $SharedDir) { Remove-Item -LiteralPath $SharedDir -Recurse -Force; Add-LabCheck 'remove_shared' 'PASS' $SharedDir } else { Add-LabCheck 'remove_shared' 'PASS' 'nothing to remove' }
    }
    Write-Result
    return
}

# ------------------------------------------------------------------------------------------------
if ($Phase -eq 'MachineProtect') {
    Assert-LabElevated -Why 'creating the shared folder and the SYSTEM-only blob'
    if (-not (Test-Path -LiteralPath $SharedDir)) { New-Item -ItemType Directory -Path $SharedDir -Force | Out-Null }
    $r = Invoke-LabNative -FilePath 'icacls.exe' -Arguments @($SharedDir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-32-545:(OI)(CI)M', '/C', '/Q')
    if ($r.ExitCode -ne 0) { Add-LabCheck 'shared_dir_acl' 'FAIL' ($r.Output -join ' '); Write-Result; return }
    Add-LabCheck 'shared_dir_acl' 'PASS' ($SharedDir + ' (SYSTEM F, Admins F, Users Modify - lab only)')
    $secret = New-LabSecret
    $entropy = New-Object byte[] 16
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    $rng.GetBytes($entropy); $rng.Dispose()
    $blob = [System.Security.Cryptography.ProtectedData]::Protect([System.Text.Encoding]::UTF8.GetBytes($secret), $entropy, $LM)
    [System.IO.File]::WriteAllBytes((Join-Path $SharedDir 'machine-open.bin'), $blob)
    [System.IO.File]::WriteAllBytes((Join-Path $SharedDir 'machine-entropy.bin'), $entropy)
    Write-LabTextFile -Path (Join-Path $SharedDir 'machine.sha256prefix') -Text (Get-LabHashPrefix $secret)
    $aclFile = Join-Path $SharedDir 'machine-acl.bin'
    [System.IO.File]::WriteAllBytes($aclFile, $blob)
    $r = Invoke-LabNative -FilePath 'icacls.exe' -Arguments @($aclFile, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F', '/C', '/Q')
    if ($r.ExitCode -eq 0) { Add-LabCheck 'machine_acl_file' 'PASS' ($aclFile + ' SYSTEM + Administrators only') } else { Add-LabCheck 'machine_acl_file' 'FAIL' ($r.Output -join ' ') }
    $back = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, $LM)
    if ((Get-LabHashPrefix ([System.Text.Encoding]::UTF8.GetString($back))) -eq (Get-LabHashPrefix $secret)) { Add-LabCheck 'machine_roundtrip' 'PASS' ('secret ' + (Get-LabHashPrefix $secret)) }
    else { Add-LabCheck 'machine_roundtrip' 'FAIL' 'mismatch' }
    Set-LabValue 'machine_secret_hash' (Get-LabHashPrefix $secret)
    Set-LabValue 'machine_blob_bytes' $blob.Length
    $secret = $null
    Write-Result
    return
}

# ------------------------------------------------------------------------------------------------
if ($Phase -eq 'Protect') {
    if ($s.IsElevated) { Write-LabWarn 'Run Protect from a normal PowerShell as labA.' }
    $pt = Get-ProfileType
    foreach ($k in $pt.Keys) { Set-LabValue ('profile.' + $k) $pt[$k] }
    Add-LabCheck 'profile_type' 'INFO' ('FSLogix enabled=' + $pt['fslogix_enabled'] + ' service=' + $pt['fslogix_service'] + '; DPAPI master key folder exists=' + $pt['dpapi_masterkey_folder_exists'] + $(if (-not $pt['fslogix_enabled']) { ' (FSLogix case not covered in this lab)' } else { '' }))
    if (-not (Test-Path -LiteralPath $userDir)) { New-Item -ItemType Directory -Path $userDir -Force | Out-Null }
    $secret = New-LabSecret
    $blob = [System.Security.Cryptography.ProtectedData]::Protect([System.Text.Encoding]::UTF8.GetBytes($secret), $null, $CU)
    [System.IO.File]::WriteAllBytes($blobPath, $blob)
    Write-LabTextFile -Path $hashPath -Text (Get-LabHashPrefix $secret)
    Write-LabTextFile -Path $stampPath -Text ((Get-Date).ToString('o'))
    $back = [System.Security.Cryptography.ProtectedData]::Unprotect([System.IO.File]::ReadAllBytes($blobPath), $null, $CU)
    if ((Get-LabHashPrefix ([System.Text.Encoding]::UTF8.GetString($back))) -eq (Get-LabHashPrefix $secret)) { Add-LabCheck 'protect_roundtrip' 'PASS' ('secret ' + (Get-LabHashPrefix $secret) + ', blob ' + $blob.Length + ' bytes at ' + $blobPath) }
    else { Add-LabCheck 'protect_roundtrip' 'FAIL' 'mismatch' }
    Set-LabValue 'secret_hash' (Get-LabHashPrefix $secret)
    $secret = $null
    if (Test-Path -LiteralPath $SharedDir) {
        try {
            Copy-Item -LiteralPath $blobPath -Destination (Join-Path $SharedDir ($env:USERNAME + '-currentuser.bin')) -Force
            Copy-Item -LiteralPath $hashPath -Destination (Join-Path $SharedDir ($env:USERNAME + '-currentuser.sha256prefix')) -Force
            Add-LabCheck 'copy_to_shared' 'PASS' ('blob copied to ' + $SharedDir + ' for the CrossUser phase')
        } catch { Add-LabCheck 'copy_to_shared' 'WARN' (Format-LabError $_) }
    } else {
        Add-LabCheck 'copy_to_shared' 'SKIP' ($SharedDir + ' missing - run -Phase MachineProtect as labAdmin first if you want the CrossUser phase')
    }
    Write-Host '>>> Now SIGN OUT (not disconnect), sign in again as this user, and run -Phase Verify.'
    Write-Result
    return
}

# ------------------------------------------------------------------------------------------------
if ($Phase -eq 'Verify') {
    if (-not (Test-Path -LiteralPath $blobPath)) { Add-LabCheck 'blob_present' 'FAIL' ('no ' + $blobPath + ' - run -Phase Protect first'); Write-Result; return }
    $pt = Get-ProfileType
    foreach ($k in $pt.Keys) { Set-LabValue ('profile.' + $k) $pt[$k] }
    $protectedAt = [datetime]::Parse((Get-Content -LiteralPath $stampPath -Raw).Trim())
    $explorer = @(Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $s.SessionId } | Sort-Object StartTime | Select-Object -First 1)
    $relogon = $false
    if ($explorer.Count -gt 0) { $relogon = ($explorer[0].StartTime -gt $protectedAt) }
    Set-LabValue 'protected_at' $protectedAt.ToString('o')
    Set-LabValue 'relogon_since_protect' $relogon
    try {
        $back = [System.Security.Cryptography.ProtectedData]::Unprotect([System.IO.File]::ReadAllBytes($blobPath), $null, $CU)
        $got = Get-LabHashPrefix ([System.Text.Encoding]::UTF8.GetString($back))
        $exp = (Get-Content -LiteralPath $hashPath -Raw).Trim()
        if ($got -eq $exp -and $relogon) { Add-LabCheck 'verify_after_relogon' 'PASS' ('decrypted after a new logon; ' + $got) }
        elseif ($got -eq $exp) { Add-LabCheck 'verify_after_relogon' 'WARN' ('decrypted, but no new logon since Protect (explorer started before Protect) - sign out/in and re-run; ' + $got) }
        else { Add-LabCheck 'verify_after_relogon' 'FAIL' ('decrypted but hash ' + $got + ' != ' + $exp) }
    } catch {
        Add-LabCheck 'verify_after_relogon' 'FAIL' (Format-LabError $_)
    }
    Write-Result
    return
}

# ------------------------------------------------------------------------------------------------
# CrossUser (labB)
if ($env:USERNAME -ieq $OwnerUser) { Write-LabWarn ('Run CrossUser as a DIFFERENT user than ' + $OwnerUser + ' (labB).') }
$ownerBlob = Join-Path $SharedDir ($OwnerUser + '-currentuser.bin')
if (Test-Path -LiteralPath $ownerBlob) {
    try {
        $null = [System.Security.Cryptography.ProtectedData]::Unprotect([System.IO.File]::ReadAllBytes($ownerBlob), $null, $CU)
        Add-LabCheck 'crossuser_currentuser_refused' 'FAIL' ($env:USERNAME + ' DECRYPTED ' + $OwnerUser + '''s CurrentUser blob')
    } catch {
        Add-LabCheck 'crossuser_currentuser_refused' 'PASS' (Format-LabError $_)
    }
} else { Add-LabCheck 'crossuser_currentuser_refused' 'SKIP' ('no ' + $ownerBlob + ' (run MachineProtect as labAdmin, then Protect as ' + $OwnerUser + ')') }

$openBlob = Join-Path $SharedDir 'machine-open.bin'
$entFile = Join-Path $SharedDir 'machine-entropy.bin'
$mHash = Join-Path $SharedDir 'machine.sha256prefix'
if ((Test-Path -LiteralPath $openBlob) -and (Test-Path -LiteralPath $entFile)) {
    $mb = [System.IO.File]::ReadAllBytes($openBlob)
    $ent = [System.IO.File]::ReadAllBytes($entFile)
    $withEnt = $false
    try {
        $back = [System.Security.Cryptography.ProtectedData]::Unprotect($mb, $ent, $LM)
        $got = Get-LabHashPrefix ([System.Text.Encoding]::UTF8.GetString($back))
        $exp = (Get-Content -LiteralPath $mHash -Raw).Trim()
        $withEnt = ($got -eq $exp)
        Add-LabCheck 'machine_scope_readable_by_other_user' 'INFO' ('IMPORTANT: ' + $env:USERNAME + ' (non-admin) decrypted the LocalMachine blob made by labAdmin, using the entropy; hash match=' + $withEnt + '. Machine-scope DPAPI secrets MUST also be file-ACL''d to SYSTEM.')
    } catch {
        Add-LabCheck 'machine_scope_readable_by_other_user' 'INFO' ('LocalMachine Unprotect with entropy failed for ' + $env:USERNAME + ': ' + (Format-LabError $_))
    }
    Set-LabValue 'machine_scope_with_entropy_decrypted' $withEnt
    try {
        $null = [System.Security.Cryptography.ProtectedData]::Unprotect($mb, $null, $LM)
        Set-LabValue 'machine_scope_without_entropy_decrypted' $true
        Add-LabCheck 'machine_scope_without_entropy' 'INFO' 'decrypted even WITHOUT the entropy (unexpected)'
    } catch {
        Set-LabValue 'machine_scope_without_entropy_decrypted' $false
        Add-LabCheck 'machine_scope_without_entropy' 'INFO' ('refused without entropy: ' + (Format-LabError $_))
    }
} else { Add-LabCheck 'machine_scope_readable_by_other_user' 'SKIP' 'run -Phase MachineProtect as labAdmin first' }

$aclBlob = Join-Path $SharedDir 'machine-acl.bin'
if (Test-Path -LiteralPath $SharedDir) {
    try {
        $null = [System.IO.File]::ReadAllBytes($aclBlob)
        Add-LabCheck 'machine_acl_copy_unreadable' 'FAIL' ($env:USERNAME + ' could READ the SYSTEM-only blob file')
    } catch {
        Add-LabCheck 'machine_acl_copy_unreadable' 'PASS' (Format-LabError $_)
    }
}
Write-Result
