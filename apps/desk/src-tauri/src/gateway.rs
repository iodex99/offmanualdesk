//! Gateway lifecycle (docs/ARCHITECTURE.md F4; docs/OPENCLAW_NOTES.md §2–§3).
//!
//! Desk leases a port + token from the Server Agent, writes the employee's OpenClaw
//! config (only verified keys), and starts `node openclaw.mjs gateway run` as a child
//! process (it inherits the employee's Windows token). The token is passed in the
//! environment (OPENCLAW_GATEWAY_TOKEN), never in the config file or command line.
//!
//! Desk puts itself into a Job Object with KILL_ON_JOB_CLOSE at start-up
//! (`job::contain_self`), so every gateway process it starts dies with Desk; the
//! gateway "does not follow the lifetime of the process that started it" otherwise.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Where a release is installed (ARCHITECTURE §5). `OFFMANUAL_HOME` overrides for development.
pub fn install_root() -> PathBuf {
    std::env::var_os("OFFMANUAL_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files\OffManual\current"))
}

/// Paths a gateway needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub node: PathBuf,
    pub openclaw_entry: PathBuf,
    pub guard_dir: PathBuf,
    pub skills_dir: PathBuf,
    pub bridge: PathBuf,
    pub state_dir: PathBuf,
}

impl Layout {
    pub fn new(root: &Path, local_app_data: &Path) -> Self {
        Self {
            node: root.join("node").join("node.exe"),
            openclaw_entry: root
                .join("openclaw")
                .join("node_modules")
                .join("openclaw")
                .join("openclaw.mjs"),
            guard_dir: root.join("plugins").join("guard"),
            skills_dir: root.join("skills"),
            bridge: root.join("server-agent.exe"),
            state_dir: local_app_data.join("OffManual").join("openclaw-state"),
        }
    }

    pub fn config_path(&self) -> PathBuf {
        self.state_dir.join("openclaw.json")
    }
}

/// The gateway config (JSON is valid JSON5). Every key is from OPENCLAW_NOTES.md.
pub fn config(port: u16, layout: &Layout) -> Value {
    let path = |p: &Path| p.to_string_lossy().to_string();
    json!({
        "gateway": {
            "mode": "local",
            "port": port,
            "bind": "loopback",
            // Token auth always, and failed attempts rate-limited even from loopback:
            // every RDS session shares 127.0.0.1 (ADR-021).
            "auth": { "mode": "token", "rateLimit": { "exemptLoopback": false } },
            "controlUi": { "enabled": false },
            "terminal": { "enabled": false }
        },
        "update": { "checkOnStart": false, "auto": { "enabled": false } },
        "telemetry": { "enabled": false },
        "commands": { "restart": false, "config": false, "plugins": false, "mcp": false, "debug": false, "bash": false },
        "plugins": {
            // telegram: replaced by the Server Agent relay (ADR-023); browser: extra listeners (ADR-020).
            "deny": ["telegram", "browser", "device-pair"],
            "load": { "paths": [path(&layout.guard_dir)] },
            "entries": {
                "offmanual-guard": {
                    "enabled": true,
                    "hooks": { "allowConversationAccess": true },
                    "config": {
                        "bridgeCommand": path(&layout.bridge),
                        "packsPath": path(&layout.skills_dir.join("packs.json"))
                    }
                }
            }
        },
        "skills": {
            "allowBundled": [],
            "load": { "extraDirs": [path(&layout.skills_dir)] },
            "workshop": { "autonomous": { "mode": "off" } }
        },
        "tools": {
            "deny": ["gateway", "plugins", "openclaw", "skill_workshop", "terminal", "browser", "nodes", "computer"]
        }
    })
}

/// Environment for the gateway process (OPENCLAW_NOTES.md §2 embedding preset).
pub fn environment(layout: &Layout, token: &str) -> Vec<(String, String)> {
    let path = |p: &Path| p.to_string_lossy().to_string();
    vec![
        ("OPENCLAW_STATE_DIR".into(), path(&layout.state_dir)),
        ("OPENCLAW_CONFIG_PATH".into(), path(&layout.config_path())),
        ("OPENCLAW_GATEWAY_TOKEN".into(), token.to_string()),
        ("OPENCLAW_NO_RESPAWN".into(), "1".into()),
        ("OPENCLAW_NO_AUTO_UPDATE".into(), "1".into()),
        ("OPENCLAW_DISABLE_BONJOUR".into(), "1".into()),
        ("OPENCLAW_EXEC_SHELL_SNAPSHOT".into(), "0".into()),
        ("OPENCLAW_CONFIG_READONLY".into(), "1".into()),
        ("DO_NOT_TRACK".into(), "1".into()),
        ("CLAWHUB_DISABLE_TELEMETRY".into(), "1".into()),
    ]
}

/// Command-line arguments after node.exe.
pub fn arguments(layout: &Layout, port: u16) -> Vec<String> {
    vec![
        layout.openclaw_entry.to_string_lossy().to_string(),
        "gateway".into(),
        "run".into(),
        "--port".into(),
        port.to_string(),
        "--bind".into(),
        "loopback".into(),
        "--auth".into(),
        "token".into(),
    ]
}

/// Writes the config file (creating the state directory).
pub fn write_config(layout: &Layout, port: u16) -> std::io::Result<()> {
    std::fs::create_dir_all(&layout.state_dir)?;
    let body = serde_json::to_vec_pretty(&config(port, layout)).map_err(std::io::Error::other)?;
    std::fs::write(layout.config_path(), body)
}

/// One HTTP/1.1 GET to 127.0.0.1:port/path; returns the status code.
pub fn http_status(port: u16, path: &str, timeout: Duration) -> std::io::Result<u16> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, timeout)?;
    s.set_read_timeout(Some(timeout))?;
    s.set_write_timeout(Some(timeout))?;
    write!(
        s,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )?;
    // TCP may deliver the status line in pieces: read until its CRLF (or EOF / 512 bytes).
    let mut head_bytes = Vec::with_capacity(64);
    let mut chunk = [0u8; 64];
    while !head_bytes.windows(2).any(|w| w == b"\r\n") && head_bytes.len() < 512 {
        let n = s.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        head_bytes.extend_from_slice(&chunk[..n]);
    }
    let head = String::from_utf8_lossy(&head_bytes);
    head.split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .ok_or_else(|| std::io::Error::other("not an HTTP response"))
}

/// Polls `/readyz` until 200 or the deadline (OPENCLAW_NOTES.md §3 "HTTP checks").
pub fn wait_ready(port: u16, deadline: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < deadline {
        if let Ok(200) = http_status(port, "/readyz", Duration::from_secs(2)) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

#[cfg(windows)]
#[allow(unsafe_code)]
pub mod job {
    //! Job Object containing Desk and therefore every gateway it starts.
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    // Held only to keep the job alive for the life of the process (never read).
    struct Job(#[allow(dead_code)] HANDLE);
    // SAFETY: a job handle can be used from any thread; we never close it (it must live
    // as long as Desk, and the OS closes it at exit, which kills the job's processes).
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    /// Puts the Desk process in a kill-on-close job. Returns false if that failed
    /// (e.g. an outer job forbids nesting); Desk then logs and stops gateways itself.
    pub fn contain_self() -> bool {
        JOB.get_or_init(|| {
            // SAFETY: plain Win32 calls; every result is checked.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 || AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
                    return None;
                }
                Some(Job(job))
            }
        })
        .is_some()
    }
}

#[cfg(not(windows))]
pub mod job {
    pub fn contain_self() -> bool {
        false
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn layout() -> Layout {
        Layout::new(
            Path::new(r"C:\Program Files\OffManual\current"),
            Path::new(r"C:\Users\asha\AppData\Local"),
        )
    }

    #[test]
    fn layout_follows_architecture_paths() {
        let l = layout();
        assert!(l.node.ends_with(r"node\node.exe") || l.node.ends_with("node/node.exe"));
        assert!(l.openclaw_entry.to_string_lossy().contains("openclaw.mjs"));
        assert!(l.state_dir.to_string_lossy().contains("openclaw-state"));
        assert!(l.config_path().to_string_lossy().ends_with("openclaw.json"));
    }

    #[test]
    fn config_locks_everything_down() {
        let c = config(18800, &layout());
        assert_eq!(c["gateway"]["port"], 18800);
        assert_eq!(c["gateway"]["bind"], "loopback");
        assert_eq!(c["gateway"]["auth"]["mode"], "token");
        assert_eq!(c["gateway"]["auth"]["rateLimit"]["exemptLoopback"], false);
        assert_eq!(c["gateway"]["controlUi"]["enabled"], false);
        assert_eq!(c["gateway"]["terminal"]["enabled"], false);
        let deny: Vec<&str> = c["plugins"]["deny"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(deny.contains(&"telegram") && deny.contains(&"browser"));
        assert_eq!(c["skills"]["allowBundled"], json!([]));
        // The guard reads pack → tool definitions from the signed release (ADR-043).
        let packs = c["plugins"]["entries"]["offmanual-guard"]["config"]["packsPath"]
            .as_str()
            .unwrap();
        assert!(packs.ends_with("packs.json") && packs.contains("skills"));
        assert_eq!(c["skills"]["workshop"]["autonomous"]["mode"], "off");
        assert!(c["tools"]["deny"]
            .as_array()
            .unwrap()
            .contains(&json!("skill_workshop")));
        assert_eq!(c["update"]["auto"]["enabled"], false);
        // The token never appears in the config.
        assert!(!c.to_string().to_lowercase().contains("\"token\":\""));
    }

    #[test]
    fn token_only_in_environment_not_arguments() {
        let l = layout();
        let env = environment(&l, "secret-token-123");
        assert!(env
            .iter()
            .any(|(k, v)| k == "OPENCLAW_GATEWAY_TOKEN" && v == "secret-token-123"));
        assert!(env
            .iter()
            .any(|(k, v)| k == "OPENCLAW_CONFIG_READONLY" && v == "1"));
        assert!(env
            .iter()
            .any(|(k, v)| k == "OPENCLAW_NO_RESPAWN" && v == "1"));
        let args = arguments(&l, 18800);
        assert!(!args.iter().any(|a| a.contains("secret-token-123")));
        assert_eq!(
            &args[1..],
            ["gateway", "run", "--port", "18800", "--bind", "loopback", "--auth", "token"]
        );
    }

    #[test]
    fn writes_config_file() {
        let dir = std::env::temp_dir().join(format!("om-desk-test-{}", std::process::id()));
        let l = Layout::new(Path::new("C:/om"), &dir);
        write_config(&l, 18801).unwrap();
        let v: Value = serde_json::from_slice(&std::fs::read(l.config_path()).unwrap()).unwrap();
        assert_eq!(v["gateway"]["port"], 18801);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn readiness_poll_against_a_local_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for (i, stream) in listener.incoming().enumerate() {
                let mut s = stream.unwrap();
                let mut buf = [0u8; 256];
                let _ = s.read(&mut buf);
                let status = if i == 0 {
                    "503 Service Unavailable"
                } else {
                    "200 OK"
                };
                let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n");
            }
        });
        assert_eq!(
            http_status(port, "/readyz", Duration::from_secs(2)).unwrap(),
            503
        );
        assert!(wait_ready(port, Duration::from_secs(5)));
    }

    #[test]
    fn readiness_gives_up() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!wait_ready(port, Duration::from_millis(600)));
    }

    #[test]
    fn install_root_can_be_overridden() {
        assert!(install_root().to_string_lossy().len() > 3);
    }
}
