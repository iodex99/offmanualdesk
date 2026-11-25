//! Desk's client for the Server Agent pipe (docs/ARCHITECTURE.md §3.1, ADR-029/034).
//!
//! * Opens `\\.\pipe\offmanual-agent` with exactly FILE_GENERIC_READ | FILE_WRITE_DATA
//!   (0x12008B). GENERIC_WRITE would be refused: it includes the create-instance right.
//! * Before sending anything, checks the server process runs as LocalSystem
//!   (GetNamedPipeServerProcessId → process token → IsWellKnownSid), so a squatter
//!   can't collect PINs or codes.
//! * One request per connection: write one JSON-RPC line, read one line back.
//! * Only methods Desk is allowed to call are accepted from the UI.

use serde::Serialize;
use serde_json::{json, Value};

/// Pipe path (must match apps/server-agent/internal/pipe.Name).
pub const PIPE_NAME: &str = r"\\.\pipe\offmanual-agent";

/// FILE_GENERIC_READ (0x120089) | FILE_WRITE_DATA (0x2).
pub const PIPE_ACCESS: u32 = 0x0012_008B;

/// Methods the Desk UI may call (subset of the shared IPC schema).
pub const DESK_METHODS: &[&str] = &[
    "session.hello",
    "auth.bindStart",
    "auth.bindComplete",
    "auth.recover",
    "auth.totpEnrolStart",
    "auth.totpEnrolConfirm",
    "auth.pinSet",
    "auth.verifyDaily",
    "auth.verifyPin",
    "auth.stepUp",
    "lock.get",
    "lock.set",
    "gateway.lease",
    "gateway.release",
    "policy.get",
    "telegram.linkStart",
    "access.denials",
    "access.request",
    "access.list",
    "access.resolve",
    "notices.list",
    "notices.ack",
    "update.status",
    "update.report",
    "unlock.telegramStart",
    "unlock.telegramStatus",
    "update.switch",
    "support.bundle",
    "support.submit",
];

/// Errors shown to the employee are plain words; details go to the log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentError {
    /// JSON-RPC error code, or a local code (-1 not running, -2 untrusted server, -3 bad reply).
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl AgentError {
    fn local(code: i64, message: &str) -> Self {
        Self {
            code,
            message: message.to_string(),
            data: None,
        }
    }
}

pub fn method_allowed(method: &str) -> bool {
    DESK_METHODS.contains(&method)
}

/// Builds one request line. `id` is fixed: one request per connection.
pub fn request_line(method: &str, params: &Value, correlation_id: &str) -> String {
    let mut line = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": if params.is_object() { params.clone() } else { json!({}) },
        "correlationId": correlation_id,
    })
    .to_string();
    line.push('\n');
    line
}

/// Interprets one reply line.
pub fn parse_reply(line: &str) -> Result<Value, AgentError> {
    let v: Value = serde_json::from_str(line.trim())
        .map_err(|_| AgentError::local(-3, "Off Manual got an unexpected reply. Try again."))?;
    if let Some(err) = v.get("error") {
        return Err(AgentError {
            code: err.get("code").and_then(Value::as_i64).unwrap_or(-32603),
            message: err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Something went wrong.")
                .to_string(),
            data: err.get("data").cloned(),
        });
    }
    v.get("result")
        .cloned()
        .ok_or_else(|| AgentError::local(-3, "Off Manual got an unexpected reply. Try again."))
}

/// Calls the Server Agent. Validates the method first.
pub fn call(method: &str, params: &Value, correlation_id: &str) -> Result<Value, AgentError> {
    if !method_allowed(method) {
        return Err(AgentError::local(-32601, "That action isn't available."));
    }
    let line = request_line(method, params, correlation_id);
    let reply = platform::round_trip(&line)?;
    parse_reply(&reply)
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod platform {
    use super::{AgentError, PIPE_ACCESS, PIPE_NAME};
    use std::fs::File;
    use std::io::{BufRead, BufReader, Write};
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, IsWellKnownSid, TokenUser, WinLocalSystemSid, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const ERROR_FILE_NOT_FOUND: u32 = 2;
    const ERROR_PIPE_BUSY: u32 = 231;
    /// SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS: the server can't impersonate Desk.
    const SQOS_ANONYMOUS: u32 = 0x0010_0000;

    fn not_running() -> AgentError {
        AgentError::local(
            -1,
            "Off Manual's server service isn't running. Please tell your admin.",
        )
    }

    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: the handle was returned by a successful Win32 open call and is closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// True if the process serving the pipe runs as LocalSystem.
    fn server_is_local_system(pipe: HANDLE) -> bool {
        let mut pid: u32 = 0;
        // SAFETY: valid pipe handle; pid is a valid out pointer.
        if unsafe { GetNamedPipeServerProcessId(pipe, &mut pid) } == 0 {
            return false;
        }
        // SAFETY: plain Win32 call; result checked for null.
        let proc = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if proc.is_null() {
            return false;
        }
        let proc = OwnedHandle(proc);
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: valid process handle; token is a valid out pointer.
        if unsafe { OpenProcessToken(proc.0, TOKEN_QUERY, &mut token) } == 0 {
            return false;
        }
        let token = OwnedHandle(token);
        let mut buf = vec![0u8; 256];
        let mut len: u32 = 0;
        // SAFETY: buffer and length are valid; TokenUser fills a TOKEN_USER followed by the SID.
        let ok = unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                buf.as_mut_ptr().cast(),
                buf.len() as u32,
                &mut len,
            )
        };
        if ok == 0 {
            return false;
        }
        // SAFETY: GetTokenInformation succeeded, so buf starts with an initialised TOKEN_USER.
        let user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
        // SAFETY: the SID pointer points into buf, which is still alive.
        unsafe { IsWellKnownSid(user.User.Sid, WinLocalSystemSid) != 0 }
    }

    fn open_pipe() -> Result<File, AgentError> {
        let name: Vec<u16> = PIPE_NAME.encode_utf16().chain(std::iter::once(0)).collect();
        for _ in 0..20 {
            // SAFETY: name is NUL-terminated UTF-16; other arguments are constants.
            let h = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    PIPE_ACCESS,
                    0,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL | SQOS_ANONYMOUS,
                    std::ptr::null_mut(),
                )
            };
            if h != INVALID_HANDLE_VALUE {
                if !server_is_local_system(h) {
                    // SAFETY: h is a valid handle we own and close exactly once here.
                    unsafe { CloseHandle(h) };
                    return Err(AgentError::local(
                        -2,
                        "Off Manual stopped because the connection didn't look safe. Please tell your admin.",
                    ));
                }
                // SAFETY: h is a valid handle; File takes ownership and closes it on drop.
                return Ok(unsafe { File::from_raw_handle(h as RawHandle) });
            }
            // SAFETY: reads the calling thread's last-error value.
            match unsafe { GetLastError() } {
                ERROR_PIPE_BUSY => std::thread::sleep(std::time::Duration::from_millis(100)),
                ERROR_FILE_NOT_FOUND => return Err(not_running()),
                _ => return Err(not_running()),
            }
        }
        Err(AgentError::local(
            -1,
            "Off Manual is busy. Try again in a moment.",
        ))
    }

    pub fn round_trip(line: &str) -> Result<String, AgentError> {
        let mut file = open_pipe()?;
        file.write_all(line.as_bytes()).map_err(|_| not_running())?;
        let mut reader = BufReader::new(file);
        let mut reply = String::new();
        reader.read_line(&mut reply).map_err(|_| not_running())?;
        if reply.is_empty() {
            return Err(not_running());
        }
        Ok(reply)
    }
}

#[cfg(not(windows))]
mod platform {
    use super::AgentError;

    pub fn round_trip(_line: &str) -> Result<String, AgentError> {
        Err(AgentError::local(
            -1,
            "Off Manual Desk runs on Windows only.",
        ))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn access_mask_excludes_create_instance() {
        assert_eq!(
            PIPE_ACCESS & 0x4,
            0,
            "FILE_CREATE_PIPE_INSTANCE must not be requested"
        );
        assert_eq!(PIPE_ACCESS, 0x0012_008B);
        assert_eq!(PIPE_NAME, r"\\.\pipe\offmanual-agent");
    }

    #[test]
    fn only_desk_methods_are_allowed() {
        assert!(method_allowed("auth.verifyPin"));
        assert!(!method_allowed("audit.append")); // guard-only
        assert!(!method_allowed("telegram.send")); // relay-only
        assert!(!method_allowed("admin.becomeSystem"));
        let err = call("audit.append", &json!({}), "c1").unwrap_err();
        assert_eq!(err.code, -32601);
    }

    #[test]
    fn request_line_is_one_ndjson_object() {
        let line = request_line("auth.verifyPin", &json!({"pin": "4821"}), "desk-abc12345");
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        let v: Value = serde_json::from_str(line.trim()).unwrap_or_default();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["method"], "auth.verifyPin");
        assert_eq!(v["params"]["pin"], "4821");
        // Non-object params become {} (the agent rejects arrays).
        let l2 = request_line("lock.get", &json!([1, 2]), "c");
        let v2: Value = serde_json::from_str(l2.trim()).unwrap_or_default();
        assert_eq!(v2["params"], json!({}));
    }

    #[test]
    fn parse_reply_maps_results_and_errors() {
        assert_eq!(
            parse_reply(r#"{"jsonrpc":"2.0","id":1,"result":{"unlocked":true}}"#),
            Ok(json!({"unlocked": true}))
        );
        let e = parse_reply(
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32003,"message":"That PIN isn't right.","data":{"remaining":2}}}"#,
        )
        .unwrap_err();
        assert_eq!(e.code, -32003);
        assert_eq!(e.message, "That PIN isn't right.");
        assert_eq!(e.data, Some(json!({"remaining": 2})));
        assert_eq!(parse_reply("not json").unwrap_err().code, -3);
        assert_eq!(
            parse_reply(r#"{"jsonrpc":"2.0","id":1}"#).unwrap_err().code,
            -3
        );
    }
}
