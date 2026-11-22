<#
.SYNOPSIS
    L7 - Does a named-pipe server get the right SID for a non-admin caller from the OS, and can a caller spoof
    another user? Also: can a non-admin user squat (create an instance of) the server's pipe?

.DESCRIPTION
    Question (docs/LAB_VALIDATION.md L7): Does the pipe server get the right SID for a non-admin caller? Can labB
    impersonate labA? Feeds ARCHITECTURE.md section 3.1 and SECURITY.md ("identity from the OS, never from the body").

    A self-contained pipe server/client (PowerShell + Add-Type C#, P/Invoke). Pipe: \\.\pipe\<PipeName>
    (default offmanual-lab). Server DACL, like the product (SYSTEM full; Authenticated Users read/write; no
    anonymous), plus "deny NETWORK" and PIPE_REJECT_REMOTE_CLIENTS. Two DACL variants:
      -AclVariant GenericWrite  D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GRGW;;;AU)        (as ARCHITECTURE.md 3.1 reads today)
      -AclVariant Strict        D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;0x0012008B;;;AU)  (FILE_GENERIC_READ|FILE_WRITE_DATA only)
    Microsoft: "FILE_GENERIC_WRITE enables permission to create the pipe [FILE_APPEND_DATA = FILE_CREATE_PIPE_INSTANCE].
    To avoid this problem, use the individual rights" - https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights
    -Role Squat tests exactly that from labB.

    For every client connection the server derives identity TWO ways (the JSON body's claimed SID is only logged):
      (a) GetNamedPipeClientProcessId -> OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) -> OpenProcessToken ->
          GetTokenInformation(TokenUser) -> SID; ProcessIdToSessionId; also GetNamedPipeClientSessionId
      (b) ImpersonateNamedPipeClient -> OpenThreadToken -> TokenUser SID + TokenImpersonationLevel -> RevertToSelf
    The identity used = (a), falling back to (b); the body claim is ignored.

    Clients connect four times with different impersonation levels in CreateFile's SQOS flags:
      Default (no SECURITY_SQOS_PRESENT), Anonymous, Identification, Impersonation
    and each time claim to be another user's SID in the JSON-RPC body (session.hello params.sid).
    Expected: (a) always correct; (b) correct for Default/Identification/Impersonation and FAILS for Anonymous
    (OpenThreadToken 1347 ERROR_CANT_OPEN_ANONYMOUS) - so the product must use (a) or reject anonymous-level callers.
    Clients also record the server's PID/session (GetNamedPipeServerProcessId / ...SessionId) - a client-side
    check against pipe squatting.

    Roles:
      -Role Server    labAdmin ELEVATED (or as SYSTEM via psexec -s). Serves until -MaxConnections or a stop request
                      from the same account (-Role Client -Stop). Close the window to abort.
      -Role Client    labA and labB, normal PowerShell, while the Server runs.
      -Role Squat     labB, normal PowerShell, while the Server runs: tries CreateNamedPipe on the same name (creates
                      an extra instance if the DACL allows FILE_CREATE_PIPE_INSTANCE), waits -SquatWaitSec for a
                      victim client (then run -Role Client as labA) and records whom it caught and at what level.
      -Role SelfTest  one user, no admin: server in a background runspace + client in the foreground, for both DACL
                      variants, including the squat attempt (dev-box smoke test; not a substitute for the RDS run).

    Microsoft Learn (API references used in the C# below):
      CreateNamedPipeW            https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipew
      ConnectNamedPipe            https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-connectnamedpipe
      GetNamedPipeClientProcessId https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeclientprocessid
      GetNamedPipeClientSessionId https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeclientsessionid
      GetNamedPipeServerProcessId https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid
      ImpersonateNamedPipeClient  https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-impersonatenamedpipeclient
      OpenThreadToken             https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openthreadtoken
      OpenProcess                 https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess
      OpenProcessToken            https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocesstoken
      GetTokenInformation         https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation
      ProcessIdToSessionId        https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-processidtosessionid
      RevertToSelf                https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-reverttoself
      CreateFileW (SECURITY_SQOS_PRESENT, SECURITY_ANONYMOUS/IDENTIFICATION/IMPERSONATION)
                                  https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
      Impersonation levels        https://learn.microsoft.com/en-us/windows/win32/secauthz/impersonation-levels
      ConvertStringSecurityDescriptorToSecurityDescriptorW
                                  https://learn.microsoft.com/en-us/windows/win32/api/sddl/nf-sddl-convertstringsecuritydescriptortosecuritydescriptorw

    Exact commands:
      labAdmin (elevated):  ...\L7-pipe-caller-sid.ps1 -Role Server -AclVariant GenericWrite
      labA:                 ...\L7-pipe-caller-sid.ps1 -Role Client
      labB:                 ...\L7-pipe-caller-sid.ps1 -Role Client
      labB:                 ...\L7-pipe-caller-sid.ps1 -Role Squat -SquatWaitSec 60   (then within 60 s, as labA: -Role Client)
      labAdmin (2nd window):...\L7-pipe-caller-sid.ps1 -Role Client -Stop               (stops the server, prints its RESULT)
      Repeat the four steps with -AclVariant Strict.

    What to paste back: Server, both Client and Squat outputs per variant (lab\results\L7-*.txt), then /lab-result L7.

    Pass criteria (measurable):
      - Server: for every connection, SID (a) equals the client's real SID (client confirms), session IDs match.
      - Client: own SID == server-derived SID for all four levels; claimed SID != used SID (spoof ignored);
        method (b) matches for Default/Identification/Impersonation; Anonymous recorded.
      - Squat: GenericWrite variant -> record whether labB could create an instance (EXPECTED: yes = risk);
        Strict variant -> creation must fail with Win32 5 (PASS).
      L7 PASS = Server PASS + Client PASS for labA and labB + Strict squat refused.

    Leaves behind: nothing (pipes vanish when the process exits). Transcripts in lab\results.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Server', 'Client', 'Squat', 'SelfTest')][string]$Role,
    [string]$PipeName = 'offmanual-lab',
    [ValidateSet('GenericWrite', 'Strict')][string]$AclVariant = 'GenericWrite',
    [int]$MaxConnections = 200,
    [string]$ClaimSid = '',
    [switch]$Stop,
    [int]$SquatWaitSec = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
trap { Write-LabUnhandled $_; break }

$cs = @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public class OmLabConn
{
    public int ConnectError;
    public string Request = "";
    public uint ClientPid;
    public uint ClientSessionApi = 0xFFFFFFFF;
    public uint ProcSession = 0xFFFFFFFF;
    public string SidA;
    public string ErrA;
    public string SidB;
    public string LevelB;
    public string ErrB;
}

public static class OmLabPipe
{
    const uint PIPE_ACCESS_DUPLEX = 0x3;
    const uint FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
    const uint PIPE_NOWAIT = 0x1;
    const uint PIPE_REJECT_REMOTE_CLIENTS = 0x8;
    const uint OPEN_EXISTING = 3;
    const uint SECURITY_SQOS_PRESENT = 0x00100000;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint TOKEN_QUERY = 0x0008;
    const int TokenUserClass = 1;
    const int TokenImpersonationLevelClass = 9;
    const int ERROR_PIPE_BUSY = 231;
    const int ERROR_NO_DATA = 232;
    const int ERROR_PIPE_CONNECTED = 535;
    const int ERROR_PIPE_LISTENING = 536;

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateNamedPipeW")]
    static extern SafeFileHandle CreateNamedPipeSa(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBuf, uint inBuf, uint timeout, ref SECURITY_ATTRIBUTES sa);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateNamedPipeW")]
    static extern SafeFileHandle CreateNamedPipeNoSa(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBuf, uint inBuf, uint timeout, IntPtr sa);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ConnectNamedPipe(SafeFileHandle h, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DisconnectNamedPipe(SafeFileHandle h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeClientProcessId(SafeFileHandle h, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeClientSessionId(SafeFileHandle h, out uint sid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeServerProcessId(SafeFileHandle h, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeServerSessionId(SafeFileHandle h, out uint sid);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool ImpersonateNamedPipeClient(SafeFileHandle h);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool RevertToSelf();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenThreadToken(IntPtr thread, uint access, bool openAsSelf, out IntPtr token);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentThread();
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr buf, int len, out int retLen);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW")]
    static extern bool ConvertSddl(string sddl, uint rev, out IntPtr sd, out uint size);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateFileW")]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "WaitNamedPipeW")]
    static extern bool WaitNamedPipe(string name, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(SafeFileHandle h, byte[] buf, uint n, out uint read, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(SafeFileHandle h, byte[] buf, uint n, out uint written, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FlushFileBuffers(SafeFileHandle h);

    static string LevelName(int l)
    {
        switch (l) { case 0: return "Anonymous"; case 1: return "Identification"; case 2: return "Impersonation"; case 3: return "Delegation"; default: return "Unknown(" + l + ")"; }
    }

    static string TokenUserSid(IntPtr tok, out string err)
    {
        err = null;
        int len;
        GetTokenInformation(tok, TokenUserClass, IntPtr.Zero, 0, out len);
        if (len <= 0) { err = "GetTokenInformation(size) win32=" + Marshal.GetLastWin32Error(); return null; }
        IntPtr buf = Marshal.AllocHGlobal(len);
        try
        {
            if (!GetTokenInformation(tok, TokenUserClass, buf, len, out len)) { err = "GetTokenInformation win32=" + Marshal.GetLastWin32Error(); return null; }
            IntPtr psid = Marshal.ReadIntPtr(buf);   // TOKEN_USER.User.Sid
            return new SecurityIdentifier(psid).Value;
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    static int TokenInt(IntPtr tok, int cls)
    {
        IntPtr buf = Marshal.AllocHGlobal(4);
        try { int len; if (!GetTokenInformation(tok, cls, buf, 4, out len)) return -1; return Marshal.ReadInt32(buf); }
        finally { Marshal.FreeHGlobal(buf); }
    }

    /// Method (a) helper: process ID -> process token -> TokenUser SID.
    public static string ProcessSid(uint pid, out string err)
    {
        err = null;
        IntPtr hp = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (hp == IntPtr.Zero) { err = "OpenProcess win32=" + Marshal.GetLastWin32Error(); return null; }
        try
        {
            IntPtr tok;
            if (!OpenProcessToken(hp, TOKEN_QUERY, out tok)) { err = "OpenProcessToken win32=" + Marshal.GetLastWin32Error(); return null; }
            try { return TokenUserSid(tok, out err); } finally { CloseHandle(tok); }
        }
        finally { CloseHandle(hp); }
    }

    public static SafeFileHandle CreateServerInstance(string name, string sddl, bool firstInstance, out int win32Error)
    {
        win32Error = 0;
        IntPtr sd; uint sz;
        if (!ConvertSddl(sddl, 1, out sd, out sz)) { win32Error = Marshal.GetLastWin32Error(); return null; }
        try
        {
            SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
            sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            sa.lpSecurityDescriptor = sd;
            sa.bInheritHandle = 0;
            uint open = PIPE_ACCESS_DUPLEX | (firstInstance ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0u);
            SafeFileHandle h = CreateNamedPipeSa(name, open, PIPE_REJECT_REMOTE_CLIENTS, 255, 65536, 65536, 0, ref sa);
            if (h.IsInvalid) { win32Error = Marshal.GetLastWin32Error(); return null; }
            return h;
        }
        finally { LocalFree(sd); }
    }

    static string ReadLine(SafeFileHandle h, int max, bool nowait, int timeoutMs)
    {
        MemoryStream ms = new MemoryStream();
        byte[] b = new byte[1];
        uint r;
        DateTime end = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (ms.Length < max)
        {
            if (!ReadFile(h, b, 1, out r, IntPtr.Zero) || r == 0)
            {
                int e = Marshal.GetLastWin32Error();
                if (nowait && e == ERROR_NO_DATA && DateTime.UtcNow < end) { System.Threading.Thread.Sleep(20); continue; }
                break;
            }
            if (b[0] == (byte)'\n') break;
            ms.WriteByte(b[0]);
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    public static void WriteLine(SafeFileHandle h, string s)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(s + "\n");
        uint w;
        WriteFile(h, bytes, (uint)bytes.Length, out w, IntPtr.Zero);
        FlushFileBuffers(h);
    }

    static void Identify(SafeFileHandle h, OmLabConn c)
    {
        // (a) client PID -> process token
        uint pid;
        if (GetNamedPipeClientProcessId(h, out pid))
        {
            c.ClientPid = pid;
            uint ps;
            if (ProcessIdToSessionId(pid, out ps)) c.ProcSession = ps;
            string e;
            c.SidA = ProcessSid(pid, out e);
            c.ErrA = e;
        }
        else c.ErrA = "GetNamedPipeClientProcessId win32=" + Marshal.GetLastWin32Error();
        uint cs;
        if (GetNamedPipeClientSessionId(h, out cs)) c.ClientSessionApi = cs;

        // (b) impersonate -> thread token -> revert (always)
        if (!ImpersonateNamedPipeClient(h)) { c.ErrB = "ImpersonateNamedPipeClient win32=" + Marshal.GetLastWin32Error(); return; }
        try
        {
            IntPtr tok;
            if (!OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, true, out tok)) { c.ErrB = "OpenThreadToken win32=" + Marshal.GetLastWin32Error(); return; }
            try
            {
                string e;
                c.SidB = TokenUserSid(tok, out e);
                c.LevelB = LevelName(TokenInt(tok, TokenImpersonationLevelClass));
                if (e != null) c.ErrB = e;
            }
            finally { CloseHandle(tok); }
        }
        finally { RevertToSelf(); }
    }

    /// Blocks until a client connects, reads one line, derives identity both ways. Caller responds + disconnects.
    public static OmLabConn ServeOne(SafeFileHandle h)
    {
        OmLabConn c = new OmLabConn();
        if (!ConnectNamedPipe(h, IntPtr.Zero))
        {
            int e = Marshal.GetLastWin32Error();
            if (e != ERROR_PIPE_CONNECTED) { c.ConnectError = e; return c; }
        }
        c.Request = ReadLine(h, 65536, false, 0);   // read before impersonating
        Identify(h, c);
        return c;
    }

    public static void Respond(SafeFileHandle h, string json) { WriteLine(h, json); }
    public static void Disconnect(SafeFileHandle h) { DisconnectNamedPipe(h); }

    /// Squatter: create an instance of an EXISTING pipe name (needs FILE_CREATE_PIPE_INSTANCE in its DACL),
    /// non-blocking, wait up to waitMs for a victim. createError != 0 means creation was refused.
    public static OmLabConn Squat(string name, int waitMs, out int createError, out bool caught)
    {
        caught = false;
        createError = 0;
        OmLabConn c = new OmLabConn();
        SafeFileHandle h = CreateNamedPipeNoSa(name, PIPE_ACCESS_DUPLEX, PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS, 255, 65536, 65536, 0, IntPtr.Zero);
        if (h.IsInvalid) { createError = Marshal.GetLastWin32Error(); return c; }
        try
        {
            DateTime end = DateTime.UtcNow.AddMilliseconds(waitMs);
            while (DateTime.UtcNow < end)
            {
                ConnectNamedPipe(h, IntPtr.Zero);
                int e = Marshal.GetLastWin32Error();
                if (e == ERROR_PIPE_CONNECTED) { caught = true; break; }
                System.Threading.Thread.Sleep(100);
            }
            if (!caught) return c;
            c.Request = ReadLine(h, 65536, true, 5000);
            Identify(h, c);
            WriteLine(h, "{\"jsonrpc\":\"2.0\",\"id\":0,\"result\":{\"squatter\":true}}");
            DisconnectNamedPipe(h);
            return c;
        }
        finally { h.Dispose(); }
    }

    /// Client: SQOS level -1 = no SECURITY_SQOS_PRESENT (default), 0 Anonymous, 1 Identification, 2 Impersonation.
    public static SafeFileHandle OpenClient(string name, uint access, int sqosLevel, out int err)
    {
        err = 0;
        uint flags = 0;
        if (sqosLevel >= 0) flags = SECURITY_SQOS_PRESENT | ((uint)sqosLevel << 16);
        for (int i = 0; i < 20; i++)
        {
            SafeFileHandle h = CreateFile(name, access, 0, IntPtr.Zero, OPEN_EXISTING, flags, IntPtr.Zero);
            if (!h.IsInvalid) return h;
            err = Marshal.GetLastWin32Error();
            if (err != ERROR_PIPE_BUSY) return null;
            WaitNamedPipe(name, 2000);
        }
        return null;
    }

    public static string Exchange(SafeFileHandle h, string line)
    {
        WriteLine(h, line);
        return ReadLine(h, 65536, false, 0);
    }

    public static uint ServerPid(SafeFileHandle h) { uint p; return GetNamedPipeServerProcessId(h, out p) ? p : 0xFFFFFFFF; }
    public static uint ServerSession(SafeFileHandle h) { uint s; return GetNamedPipeServerSessionId(h, out s) ? s : 0xFFFFFFFF; }
}
'@
if (-not ('OmLabPipe' -as [type])) { Add-Type -TypeDefinition $cs -Language CSharp }

$fullPipe = '\\.\pipe\' + $PipeName
$sddlByVariant = @{
    GenericWrite = 'D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GRGW;;;AU)'
    Strict       = 'D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;0x0012008B;;;AU)'
}
# Hex literals >= 0x80000000 are negative Int32 in PowerShell, so convert from strings.
$GENERIC_READ_WRITE_DATA = [Convert]::ToUInt32('80000002', 16)   # GENERIC_READ | FILE_WRITE_DATA (works with both DACL variants)
$GENERIC_READ_WRITE = [Convert]::ToUInt32('C0000000', 16)        # GENERIC_READ | GENERIC_WRITE
$levels = @(@{ Name = 'Default'; Value = -1 }, @{ Name = 'Anonymous'; Value = 0 }, @{ Name = 'Identification'; Value = 1 }, @{ Name = 'Impersonation'; Value = 2 })

function ConvertTo-JsonString { param([AllowNull()][string]$s) if ($null -eq $s) { return 'null' } return ('"' + ($s -replace '\\', '\\' -replace '"', '\"') + '"') }

function New-ServerResponse {
    param($Conn, [int]$N, [string]$Used, [string]$Claimed, $ReqId)
    $idText = 'null'
    if ($null -ne $ReqId) { $idText = [string]$ReqId }
    return ('{"jsonrpc":"2.0","id":' + $idText + ',"result":{"conn":' + $N +
            ',"os_sid_a":' + (ConvertTo-JsonString $Conn.SidA) + ',"os_session_a":' + $Conn.ProcSession +
            ',"pipe_client_session":' + $Conn.ClientSessionApi + ',"os_sid_b":' + (ConvertTo-JsonString $Conn.SidB) +
            ',"impersonation_level_b":' + (ConvertTo-JsonString $Conn.LevelB) + ',"err_a":' + (ConvertTo-JsonString $Conn.ErrA) +
            ',"err_b":' + (ConvertTo-JsonString $Conn.ErrB) + ',"claimed_sid":' + (ConvertTo-JsonString $Claimed) +
            ',"identity_used":' + (ConvertTo-JsonString $Used) + ',"claim_ignored":' + $(if ($Claimed -and $Claimed -ne $Used) { 'true' } else { 'false' }) + '}}')
}

function Get-RequestInfo {
    param([string]$Request)
    $claimed = ''; $id = $null; $isStop = $false
    try {
        $j = $Request | ConvertFrom-Json
        $cmdProp = $j.PSObject.Properties['cmd']
        if ($null -ne $cmdProp -and [string]$cmdProp.Value -eq 'stop') { $isStop = $true }
        $idProp = $j.PSObject.Properties['id']
        if ($null -ne $idProp) { $id = $idProp.Value }
        $pp = $j.PSObject.Properties['params']
        if ($null -ne $pp -and $null -ne $pp.Value) { $sp = $pp.Value.PSObject.Properties['sid']; if ($null -ne $sp) { $claimed = [string]$sp.Value } }
    } catch { $null = $_ }
    return [pscustomobject]@{ Claimed = $claimed; Id = $id; IsStop = $isStop }
}

function Invoke-ClientSequence {
    <# Runs the four SQOS levels against the server; records checks. Returns $true if all good. #>
    param([string]$MySid, [string]$Claim)
    $allOk = $true
    foreach ($lv in $levels) {
        $err = 0
        $h = [OmLabPipe]::OpenClient($fullPipe, $GENERIC_READ_WRITE_DATA, [int]$lv.Value, [ref]$err)
        if ($null -eq $h) { Add-LabCheck ('client_' + $lv.Name) 'FAIL' ('CreateFile win32=' + $err); $allOk = $false; continue }
        try {
            $spid = [OmLabPipe]::ServerPid($h); $ssess = [OmLabPipe]::ServerSession($h)
            $serr = $null
            $ssid = [OmLabPipe]::ProcessSid($spid, [ref]$serr)
            $req = '{"jsonrpc":"2.0","id":' + ($levels.IndexOf($lv) + 1) + ',"method":"session.hello","params":{"sid":"' + $Claim + '","user":"spoofed"}}'
            $respText = [OmLabPipe]::Exchange($h, $req)
        } finally { $h.Dispose() }
        $srvText = 'server pid ' + $spid + ' session ' + $ssess + ' sid ' + $(if ($ssid) { $ssid } else { '(not readable: ' + $serr + ')' })
        Set-LabValue ('client.' + $lv.Name + '.server') $srvText
        $r = $null
        try { $r = ($respText | ConvertFrom-Json).result } catch { $null = $_ }
        if ($null -eq $r) { Add-LabCheck ('client_' + $lv.Name) 'FAIL' ('bad response: ' + $respText); $allOk = $false; continue }
        if ($null -ne $r.PSObject.Properties['squatter']) { Add-LabCheck ('client_' + $lv.Name) 'FAIL' ('answered by a SQUATTER instance; ' + $srvText); $allOk = $false; continue }
        $d = 'a=' + $r.os_sid_a + ' (session ' + $r.os_session_a + ') b=' + $r.os_sid_b + ' level=' + $r.impersonation_level_b + ' err_b=' + $r.err_b + ' used=' + $r.identity_used + ' claimed=' + $r.claimed_sid
        Set-LabValue ('client.' + $lv.Name) $d
        $aOk = ([string]$r.os_sid_a -eq $MySid)
        $usedOk = ([string]$r.identity_used -eq $MySid)
        $spoofIgnored = ($usedOk -and ([string]$r.claimed_sid -ne $MySid))
        $bOk = ([string]$r.os_sid_b -eq $MySid)
        if ($lv.Name -eq 'Anonymous') {
            if ($aOk -and $spoofIgnored) { Add-LabCheck ('client_' + $lv.Name) 'PASS' ('(a) correct; (b) ' + $(if ($bOk) { 'also correct (!)' } else { 'not usable: ' + $r.err_b })) }
            else { Add-LabCheck ('client_' + $lv.Name) 'FAIL' $d; $allOk = $false }
        } else {
            if ($aOk -and $bOk -and $spoofIgnored) { Add-LabCheck ('client_' + $lv.Name) 'PASS' ('(a)=(b)=own SID, level ' + $r.impersonation_level_b + ', claim ignored') }
            else { Add-LabCheck ('client_' + $lv.Name) 'FAIL' $d; $allOk = $false }
        }
    }
    # Can this client open the pipe with GENERIC_WRITE (includes FILE_CREATE_PIPE_INSTANCE)?
    $err = 0
    $h = [OmLabPipe]::OpenClient($fullPipe, $GENERIC_READ_WRITE, -1, [ref]$err)
    if ($null -ne $h) {
        try { $null = [OmLabPipe]::Exchange($h, '{"jsonrpc":"2.0","id":99,"method":"ping"}') } finally { $h.Dispose() }
        Add-LabCheck 'client_open_generic_write' 'INFO' 'GENERIC_READ|GENERIC_WRITE open allowed'
    } else { Add-LabCheck 'client_open_generic_write' 'INFO' ('GENERIC_READ|GENERIC_WRITE open refused win32=' + $err + ' (expected with the Strict DACL)') }
    return $allOk
}

function Invoke-SquatAttempt {
    param([int]$WaitMs)
    $cerr = 0; $caught = $false
    $c = [OmLabPipe]::Squat($fullPipe, $WaitMs, [ref]$cerr, [ref]$caught)
    if ($cerr -ne 0) {
        if ($cerr -eq 5) { Add-LabCheck 'squat_create_instance' 'PASS' 'CreateNamedPipe refused (win32 5 ACCESS_DENIED): DACL does not grant FILE_CREATE_PIPE_INSTANCE' }
        else { Add-LabCheck 'squat_create_instance' 'INFO' ('CreateNamedPipe failed win32=' + $cerr + ' (2/231 = no server running?)') }
        Set-LabValue 'squat_create_error' $cerr
        return
    }
    Set-LabValue 'squat_create_error' 0
    Add-LabCheck 'squat_create_instance' 'WARN' 'this non-server account CREATED an instance of the server''s pipe (DACL grants FILE_CREATE_PIPE_INSTANCE via GENERIC_WRITE)'
    if ($caught) {
        Set-LabValue 'squat_caught' ('pid ' + $c.ClientPid + ' sid ' + $c.SidA + ' level ' + $c.LevelB + ' errB ' + $c.ErrB)
        Add-LabCheck 'squat_caught_client' 'WARN' ('caught a client: SID ' + $c.SidA + ', impersonation level ' + $c.LevelB + ' ' + $c.ErrB)
    } else { Add-LabCheck 'squat_caught_client' 'INFO' ('no client connected to the squat instance within ' + [int]($WaitMs / 1000) + ' s') }
}

# ------------------------------------------------------------------------------------------------
$null = Start-LabTranscript -Id 'L7' -Suffix ($Role + '-' + $AclVariant + '-' + $env:USERNAME)
$s = Write-SessionInfo
Set-LabValue 'role' $Role
Set-LabValue 'pipe' $fullPipe
Set-LabValue 'acl_variant' $AclVariant
Set-LabValue 'sddl' $sddlByVariant[$AclVariant]

if (-not $ClaimSid) {
    $other = 'labB'
    if ($env:USERNAME -ieq 'labB') { $other = 'labA' }
    try { $ClaimSid = Resolve-LabAccountSid -Account $other } catch { $ClaimSid = 'S-1-5-21-1111111111-2222222222-3333333333-1001' }
}
Set-LabValue 'claim_sid' $ClaimSid

if ($Role -eq 'Server') {
    if (-not $s.IsElevated -and -not $s.IsSystem) { Write-LabWarn 'Server is not elevated. The product server runs as SYSTEM; run elevated (or psexec -s) for the real test.' }
    $sddl = $sddlByVariant[$AclVariant]
    $n = 0
    $mismatch = 0
    Write-LabInfo ('Serving ' + $fullPipe + ' with ' + $sddl + '. Stop with: -Role Client -Stop (as ' + $s.User + ')')
    while ($n -lt $MaxConnections) {
        $err = 0
        $h = [OmLabPipe]::CreateServerInstance($fullPipe, $sddl, $true, [ref]$err)
        if ($null -eq $h) {
            if ($err -eq 5) { Add-LabCheck 'server_first_instance' 'FAIL' 'FILE_FLAG_FIRST_PIPE_INSTANCE failed with ACCESS_DENIED: another process already owns an instance of this pipe name (squatted)' }
            else { Add-LabCheck 'server_create' 'FAIL' ('CreateNamedPipe win32=' + $err) }
            break
        }
        try {
            $c = [OmLabPipe]::ServeOne($h)
            if ($c.ConnectError -ne 0) { Write-LabInfo ('connect error ' + $c.ConnectError); continue }
            $n++
            $ri = Get-RequestInfo -Request $c.Request
            $used = $c.SidA
            if (-not $used) { $used = $c.SidB }
            if ($ri.IsStop -and ($used -eq $s.Sid -or $used -eq 'S-1-5-18')) {
                [OmLabPipe]::Respond($h, '{"stopping":true}')
                Write-LabInfo ('stop request from ' + $used)
                [OmLabPipe]::Disconnect($h)
                break
            }
            [OmLabPipe]::Respond($h, (New-ServerResponse -Conn $c -N $n -Used $used -Claimed $ri.Claimed -ReqId $ri.Id))
            [OmLabPipe]::Disconnect($h)
            $line = '#' + $n + ' pid ' + $c.ClientPid + ' procSession ' + $c.ProcSession + ' pipeSession ' + $c.ClientSessionApi + ' (a) ' + $c.SidA + ' ' + $c.ErrA +
                    ' | (b) ' + $c.SidB + ' level ' + $c.LevelB + ' ' + $c.ErrB + ' | claimed ' + $ri.Claimed + ' | used ' + $used
            Write-LabInfo $line
            Set-LabValue ('conn' + $n) $line
            if ($c.SidA -and $c.SidB -and $c.SidA -ne $c.SidB) { $mismatch++ }
            if (-not $c.SidA) { Add-LabCheck ('conn' + $n + '_method_a') 'FAIL' ('method (a) failed: ' + $c.ErrA) }
            if ($c.ProcSession -ne $c.ClientSessionApi) { Add-LabCheck ('conn' + $n + '_session') 'WARN' ('ProcessIdToSessionId ' + $c.ProcSession + ' != GetNamedPipeClientSessionId ' + $c.ClientSessionApi) }
        } finally { $h.Dispose() }
    }
    Set-LabValue 'connections' $n
    Set-LabValue 'a_b_mismatches' $mismatch
    if ($n -gt 0 -and $mismatch -eq 0) { Add-LabCheck 'server_identity' 'PASS' ($n.ToString() + ' connections; (a) and (b) agreed whenever (b) was available; body claims never used') }
    elseif ($n -gt 0) { Add-LabCheck 'server_identity' 'FAIL' ($mismatch.ToString() + ' connections where (a) != (b)') }
    else { Add-LabCheck 'server_identity' 'WARN' 'no client connections' }
    Write-Result
    return
}

if ($Role -eq 'Client') {
    if ($Stop) {
        $err = 0
        $h = [OmLabPipe]::OpenClient($fullPipe, $GENERIC_READ_WRITE_DATA, 1, [ref]$err)
        if ($null -eq $h) { Add-LabCheck 'stop' 'FAIL' ('cannot open pipe win32=' + $err) }
        else { try { $resp = [OmLabPipe]::Exchange($h, '{"cmd":"stop"}'); Add-LabCheck 'stop' 'INFO' $resp } finally { $h.Dispose() } }
        Write-Result
        return
    }
    if ($s.IsElevated) { Write-LabWarn 'Run the Client from a normal (non-admin) PowerShell as labA / labB.' }
    $ok = Invoke-ClientSequence -MySid $s.Sid -Claim $ClaimSid
    Set-LabValue 'client_all_ok' $ok
    Write-Result
    return
}

if ($Role -eq 'Squat') {
    Write-LabInfo ('Trying to create an instance of ' + $fullPipe + ' and waiting ' + $SquatWaitSec + ' s for a victim. Now run -Role Client as labA.')
    Invoke-SquatAttempt -WaitMs ($SquatWaitSec * 1000)
    Write-Result
    return
}

# ------------------------------------------------------------------------------------------------
# SelfTest: server in a background runspace (same process, same user) + client in the foreground.
foreach ($variant in @('GenericWrite', 'Strict')) {
    Write-LabSection ('SelfTest variant ' + $variant)
    $sddl = $sddlByVariant[$variant]
    $selfPipe = '\\.\pipe\' + $PipeName + '-selftest-' + $PID
    $script:fullPipe = $selfPipe
    $ps = [powershell]::Create()
    $null = $ps.AddScript({
        param($name, $sddl, $max)
        $out = New-Object System.Collections.ArrayList
        for ($i = 0; $i -lt $max; $i++) {
            $err = 0
            $h = [OmLabPipe]::CreateServerInstance($name, $sddl, $true, [ref]$err)
            if ($null -eq $h) { $null = $out.Add('create failed win32=' + $err); break }
            try {
                $c = [OmLabPipe]::ServeOne($h)
                if ($c.Request -match '"cmd":"stop"') { [OmLabPipe]::Respond($h, '{"stopping":true}'); [OmLabPipe]::Disconnect($h); break }
                $used = $c.SidA; if (-not $used) { $used = $c.SidB }
                $claimed = ''
                if ($c.Request -match '"sid":"([^"]*)"') { $claimed = $Matches[1] }
                $idm = [regex]::Match($c.Request, '"id":(\d+)'); $id = 'null'; if ($idm.Success) { $id = $idm.Groups[1].Value }
                $q = { param($v) if ($null -eq $v) { 'null' } else { '"' + ($v -replace '\\', '\\' -replace '"', '\"') + '"' } }
                $resp = '{"jsonrpc":"2.0","id":' + $id + ',"result":{"conn":' + ($i + 1) + ',"os_sid_a":' + (& $q $c.SidA) + ',"os_session_a":' + $c.ProcSession +
                        ',"pipe_client_session":' + $c.ClientSessionApi + ',"os_sid_b":' + (& $q $c.SidB) + ',"impersonation_level_b":' + (& $q $c.LevelB) +
                        ',"err_a":' + (& $q $c.ErrA) + ',"err_b":' + (& $q $c.ErrB) + ',"claimed_sid":' + (& $q $claimed) + ',"identity_used":' + (& $q $used) + '}}'
                [OmLabPipe]::Respond($h, $resp)
                [OmLabPipe]::Disconnect($h)
                $null = $out.Add('conn ' + ($i + 1) + ' a=' + $c.SidA + ' b=' + $c.SidB + ' level=' + $c.LevelB + ' errB=' + $c.ErrB)
            } finally { $h.Dispose() }
        }
        return $out
    }).AddArgument($selfPipe).AddArgument($sddl).AddArgument(20)
    $async = $ps.BeginInvoke()
    Start-Sleep -Milliseconds 500
    $null = Invoke-ClientSequence -MySid $s.Sid -Claim $ClaimSid
    # While the server waits for its next client, try to squat its pipe name from this (non-server-identity) context.
    Invoke-SquatAttempt -WaitMs 500
    $err = 0
    $h = [OmLabPipe]::OpenClient($selfPipe, $GENERIC_READ_WRITE_DATA, 1, [ref]$err)
    if ($null -ne $h) { try { $null = [OmLabPipe]::Exchange($h, '{"cmd":"stop"}') } finally { $h.Dispose() } }
    $serverLog = $ps.EndInvoke($async)
    $ps.Dispose()
    foreach ($l in $serverLog) { Write-LabInfo ('server| ' + $l) }
    # Rename this variant's checks so both variants appear in the paste block.
    foreach ($c in $script:LabChecks) { if ($c.Name -notmatch '^(GenericWrite|Strict)\.') { $c.Name = $variant + '.' + $c.Name } }
    foreach ($k in @($script:LabValues.Keys)) {
        if ($k -match '^(client\.|squat_)') { $script:LabValues[$variant + '.' + $k] = $script:LabValues[$k]; $script:LabValues.Remove($k) }
    }
}
Add-LabCheck 'selftest_note' 'INFO' 'single-user smoke test: the squat attempt ran as the SAME user as the server; the RDS run (labB vs labAdmin/SYSTEM server) is the real test'
Write-Result
