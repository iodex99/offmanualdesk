//! One Desk per Windows session, and handing a second launch's request to it (ADR-059).
//!
//! * The mutex `Local\OffManualDesk` lives in the session namespace: one Desk per RDS
//!   session, while other employees' sessions are unaffected (a `Global\` name would
//!   block the second user) [A L8: lab stand-in used the same scheme].
//! * A second launch (autostart again, the Start menu, or Explorer's "Ask Off Manual"
//!   with `--ask <path>`) writes its request to `%LOCALAPPDATA%\OffManual\desk\inbox`
//!   (the employee's own profile, so other users can't write there), sets the event
//!   `Local\OffManualDesk-wake` and exits.
//! * The first instance drains the inbox at start and whenever the event fires, shows
//!   its window and queues "ask" requests for the UI (`inbox_take`).
//!
//! FFI verified against windows-sys 0.61.2 (`Win32/System/Threading`, `Win32/Foundation`).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const MUTEX_NAME: &str = r"Local\OffManualDesk";
pub const EVENT_NAME: &str = r"Local\OffManualDesk-wake";
/// Tauri event telling the UI that requests are waiting (it then calls `inbox_take`).
pub const INBOX_SIGNAL: &str = "om-inbox";

const MAX_REQUESTS: usize = 20;
const MAX_FILE_BYTES: u64 = 4096;
const MAX_PATH_CHARS: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Request {
    /// Bring the window to the front.
    Show,
    /// "Ask Off Manual" about a file or folder from Explorer.
    Ask { path: String },
}

/// Desk's command line after the program name: `--ask <path>` asks about a path;
/// anything else just shows the window.
pub fn request_from_args<I: IntoIterator<Item = String>>(args: I) -> Request {
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        if a == "--ask" {
            return it
                .next()
                .and_then(|p| valid_path(&p))
                .map_or(Request::Show, |path| Request::Ask { path });
        }
    }
    Request::Show
}

/// An absolute drive or UNC path without control characters (≤ 1024 characters).
/// Device paths (`\\?\`, `\\.\`) are refused. Desk only shows the path and puts it in
/// the chat box; Windows rights decide what the assistant can open.
pub fn valid_path(p: &str) -> Option<String> {
    let p = p.trim();
    if p.is_empty() || p.chars().count() > MAX_PATH_CHARS || p.chars().any(char::is_control) {
        return None;
    }
    let b = p.as_bytes();
    let drive = b.len() >= 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/');
    let unc =
        p.starts_with(r"\\") && !p.starts_with(r"\\?\") && !p.starts_with(r"\\.\") && p.len() > 2;
    (drive || unc).then(|| p.to_string())
}

pub fn inbox_dir(local_app_data: &Path) -> PathBuf {
    local_app_data.join("OffManual").join("desk").join("inbox")
}

/// Writes a request for the running instance; `unique` must sort by time.
pub fn post(inbox: &Path, req: &Request, unique: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(inbox)?;
    let body = serde_json::to_vec(req).map_err(std::io::Error::other)?;
    let tmp = inbox.join(format!("{unique}.tmp"));
    std::fs::write(&tmp, body)?;
    // Rename so the reader never sees half a file.
    std::fs::rename(&tmp, inbox.join(format!("{unique}.json")))
}

/// Reads and removes waiting requests, oldest first. Unreadable, oversized or invalid
/// files are removed and skipped; at most 20 requests are returned.
pub fn drain(inbox: &Path) -> Vec<Request> {
    let Ok(entries) = std::fs::read_dir(inbox) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    let mut out = Vec::new();
    for f in files {
        let small =
            std::fs::symlink_metadata(&f).is_ok_and(|m| m.is_file() && m.len() <= MAX_FILE_BYTES);
        let req = if small {
            std::fs::read(&f)
                .ok()
                .and_then(|b| serde_json::from_slice::<Request>(&b).ok())
        } else {
            None
        };
        let _ = std::fs::remove_file(&f);
        if let Some(r) = req.and_then(checked) {
            if out.len() < MAX_REQUESTS {
                out.push(r);
            }
        }
    }
    out
}

fn checked(r: Request) -> Option<Request> {
    match r {
        Request::Show => Some(Request::Show),
        Request::Ask { path } => valid_path(&path).map(|path| Request::Ask { path }),
    }
}

/// A name that sorts by time and is unique per process.
pub fn unique_name() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:024}-{}", std::process::id())
}

/// The result of trying to become this session's Desk.
pub enum Claim {
    /// This is the first Desk in the session; keep the guard for the process lifetime.
    First(platform::Handle),
    /// Another Desk runs in this session.
    Second,
    /// Couldn't tell (the OS refused); run anyway rather than leave the employee without Desk.
    Unknown,
}

pub fn claim() -> Claim {
    claim_named(MUTEX_NAME)
}

pub fn claim_named(name: &str) -> Claim {
    match platform::create_mutex(name) {
        Ok(Some(h)) => Claim::First(h),
        Ok(None) => Claim::Second,
        Err(_) => Claim::Unknown,
    }
}

/// Second launch: hand the request to the running Desk and wake it.
pub fn forward(inbox: &Path, req: &Request) -> std::io::Result<()> {
    post(inbox, req, &unique_name())?;
    platform::signal(EVENT_NAME)
}

/// First instance: calls `deliver` with waiting requests now and whenever a later
/// launch wakes it. Runs on its own thread for the life of the process.
pub fn listen<F>(inbox: PathBuf, deliver: F)
where
    F: Fn(Vec<Request>) + Send + 'static,
{
    listen_named(EVENT_NAME, inbox, deliver);
}

pub fn listen_named<F>(event: &str, inbox: PathBuf, deliver: F)
where
    F: Fn(Vec<Request>) + Send + 'static,
{
    // Create the event before the first drain: a launch that raced us either finds the
    // event or left its file for this drain.
    let ev = platform::create_event(event).ok();
    let first = drain(&inbox);
    if !first.is_empty() {
        deliver(first);
    }
    let Some(ev) = ev else { return };
    std::thread::spawn(move || {
        while platform::wait(&ev) {
            let reqs = drain(&inbox);
            if !reqs.is_empty() {
                deliver(reqs);
            }
        }
    });
}

#[cfg(windows)]
#[allow(unsafe_code)]
pub mod platform {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, CreateMutexW, OpenEventW, SetEvent, WaitForSingleObject, EVENT_MODIFY_STATE,
        INFINITE,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// An owned kernel handle, closed on drop.
    pub struct Handle(HANDLE);
    // SAFETY: a kernel handle value may be used and closed from any thread.
    unsafe impl Send for Handle {}
    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: self.0 is a valid handle we own and close exactly once.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// Some(handle) when this call created the mutex; None when it already existed.
    pub fn create_mutex(name: &str) -> std::io::Result<Option<Handle>> {
        let n = wide(name);
        // SAFETY: n is NUL-terminated and outlives the call; null attributes = default
        // security; not taking ownership (existence is the signal).
        let h = unsafe { CreateMutexW(std::ptr::null(), 0, n.as_ptr()) };
        // SAFETY: no arguments; read immediately after the call it describes.
        let last = unsafe { GetLastError() };
        if h.is_null() {
            return Err(std::io::Error::from_raw_os_error(last as i32));
        }
        let handle = Handle(h);
        if last == ERROR_ALREADY_EXISTS {
            return Ok(None);
        }
        Ok(Some(handle))
    }

    /// Auto-reset event the first instance waits on.
    pub fn create_event(name: &str) -> std::io::Result<Handle> {
        let n = wide(name);
        // SAFETY: as above; auto-reset (bManualReset = 0), initially not signalled.
        let h = unsafe { CreateEventW(std::ptr::null(), 0, 0, n.as_ptr()) };
        if h.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Handle(h))
    }

    /// Wakes the first instance (no-op error if it hasn't created the event yet; it
    /// drains the inbox when it does).
    pub fn signal(name: &str) -> std::io::Result<()> {
        let n = wide(name);
        // SAFETY: n is NUL-terminated; only EVENT_MODIFY_STATE is requested.
        let h = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, n.as_ptr()) };
        if h.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let ev = Handle(h);
        // SAFETY: ev.0 is a valid event handle with EVENT_MODIFY_STATE.
        if unsafe { SetEvent(ev.0) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    /// Blocks until the event is set; false if waiting failed.
    pub fn wait(ev: &Handle) -> bool {
        // SAFETY: ev.0 is a valid event handle for the life of ev.
        unsafe { WaitForSingleObject(ev.0, INFINITE) == WAIT_OBJECT_0 }
    }
}

#[cfg(not(windows))]
pub mod platform {
    /// Off Windows there is no session namespace; every launch runs.
    pub struct Handle;
    pub fn create_mutex(_name: &str) -> std::io::Result<Option<Handle>> {
        Ok(Some(Handle))
    }
    pub fn create_event(_name: &str) -> std::io::Result<Handle> {
        Err(std::io::Error::other("not supported"))
    }
    pub fn signal(_name: &str) -> std::io::Result<()> {
        Err(std::io::Error::other("not supported"))
    }
    pub fn wait(_ev: &Handle) -> bool {
        false
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn command_line() {
        assert_eq!(request_from_args(args(&[])), Request::Show);
        assert_eq!(
            request_from_args(args(&["--ask", r"\\fs01\Clients\Mehta Traders"])),
            Request::Ask {
                path: r"\\fs01\Clients\Mehta Traders".into()
            }
        );
        assert_eq!(
            request_from_args(args(&["--ask", r"C:\Clients\a.xlsx"])),
            Request::Ask {
                path: r"C:\Clients\a.xlsx".into()
            }
        );
        assert_eq!(request_from_args(args(&["--ask"])), Request::Show);
        assert_eq!(
            request_from_args(args(&["--ask", "relative.txt"])),
            Request::Show
        );
        assert_eq!(
            request_from_args(args(&["--other", r"C:\x"])),
            Request::Show
        );
    }

    #[test]
    fn paths() {
        assert!(valid_path(r"C:\a").is_some());
        assert!(valid_path("C:/a").is_some());
        assert!(valid_path(r"\\server\share").is_some());
        for bad in [
            r"\\?\C:\a",
            r"\\.\pipe\x",
            r"\\",
            "a\nb",
            "",
            "C:",
            "x:a",
            "file.txt",
        ] {
            assert!(valid_path(bad).is_none(), "{bad:?}");
        }
        assert!(valid_path(&format!(r"C:\{}", "a".repeat(1100))).is_none());
    }

    #[test]
    fn post_and_drain() {
        let dir = std::env::temp_dir().join(format!("om-inbox-{}", unique_name()));
        post(
            &dir,
            &Request::Ask {
                path: r"C:\b".into(),
            },
            "0002",
        )
        .unwrap();
        post(&dir, &Request::Show, "0001").unwrap();
        std::fs::write(dir.join("0003.json"), b"not json").unwrap();
        std::fs::write(
            dir.join("0004.json"),
            br#"{"kind":"ask","path":"relative"}"#,
        )
        .unwrap();
        std::fs::write(dir.join("0005.json"), vec![b' '; 5000]).unwrap();
        std::fs::write(dir.join("0006.tmp"), b"{}").unwrap();
        assert_eq!(
            drain(&dir),
            vec![
                Request::Show,
                Request::Ask {
                    path: r"C:\b".into()
                }
            ]
        );
        // Every .json is gone (good or bad); a half-written .tmp is left alone.
        let left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, vec![std::ffi::OsString::from("0006.tmp")]);
        assert!(drain(&dir.join("missing")).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn second_claim_in_the_same_session_is_refused() {
        let name = format!(r"Local\OffManualDeskTest-{}", unique_name());
        let first = claim_named(&name);
        assert!(matches!(first, Claim::First(_)));
        assert!(matches!(claim_named(&name), Claim::Second));
        drop(first);
        // Released with the first instance: the next launch becomes the first again.
        assert!(matches!(claim_named(&name), Claim::First(_)));
    }

    #[cfg(windows)]
    #[test]
    fn a_second_launch_wakes_the_first() {
        let event = format!(r"Local\OffManualDeskTestEv-{}", unique_name());
        let dir = std::env::temp_dir().join(format!("om-inbox-{}", unique_name()));
        let (tx, rx) = std::sync::mpsc::channel();
        listen_named(&event, dir.clone(), move |reqs| {
            let _ = tx.send(reqs);
        });
        post(
            &dir,
            &Request::Ask {
                path: r"C:\Clients\x.xlsx".into(),
            },
            &unique_name(),
        )
        .unwrap();
        platform::signal(&event).unwrap();
        let got = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        assert_eq!(
            got,
            vec![Request::Ask {
                path: r"C:\Clients\x.xlsx".into()
            }]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
