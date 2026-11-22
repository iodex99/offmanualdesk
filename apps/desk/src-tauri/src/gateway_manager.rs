//! Starts and stops the employee's gateway (F4 steps 1–5). The token stays in Rust
//! memory; the UI only ever sees status.

use crate::agent_client;
use crate::gateway::{self, Layout, Startup};
use crate::versions;
use serde::Serialize;
use serde_json::json;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

pub struct Running {
    pub port: u16,
    /// Used by the chat client (ADR-021); never sent to the UI.
    pub token: String,
    child: Child,
}

#[derive(Default)]
pub struct GatewayState(pub Mutex<Option<Running>>);

impl GatewayState {
    /// Port and token of the running gateway, for Desk's own client only.
    pub fn endpoint(&self) -> Option<(u16, String)> {
        let mut guard = self.0.lock().ok()?;
        let r = guard.as_mut()?;
        if matches!(r.child.try_wait(), Ok(None)) {
            Some((r.port, r.token.clone()))
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GatewayStatus {
    pub running: bool,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GatewayError {
    pub message: String,
}

fn err(message: &str) -> GatewayError {
    GatewayError {
        message: message.to_string(),
    }
}

fn local_app_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
}

/// A failed start, with the state snapshot Doctor took (if it ran) for rollback.
struct StartFailure {
    error: GatewayError,
    backup: Option<PathBuf>,
}

impl From<GatewayError> for StartFailure {
    fn from(error: GatewayError) -> Self {
        StartFailure {
            error,
            backup: None,
        }
    }
}

/// F4: lease → config → spawn → readiness. Idempotent while a gateway is running.
pub fn start(state: &GatewayState, correlation_id: &str) -> Result<GatewayStatus, GatewayError> {
    start_inner(state, correlation_id).map_err(|f| f.error)
}

fn start_inner(state: &GatewayState, correlation_id: &str) -> Result<GatewayStatus, StartFailure> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| err("Off Manual hit a problem. Restart it."))?;
    if let Some(r) = guard.as_mut() {
        if matches!(r.child.try_wait(), Ok(None)) {
            return Ok(GatewayStatus {
                running: true,
                port: Some(r.port),
            });
        }
        *guard = None; // it exited; start a new one
    }
    let lease = agent_client::call("gateway.lease", &json!({}), correlation_id)
        .map_err(|e| err(&e.message))?;
    let port = lease["port"]
        .as_u64()
        .and_then(|p| u16::try_from(p).ok())
        .ok_or_else(|| err("Unexpected reply from the server."))?;
    let token = lease["token"]
        .as_str()
        .ok_or_else(|| err("Unexpected reply from the server."))?
        .to_string();

    let lad =
        local_app_data().ok_or_else(|| err("Your Windows profile folder couldn't be found."))?;
    // The employee's chosen version (ADR-048), else `current`.
    let choice = versions::load(&versions::choice_path(&lad));
    let layout = Layout::new(&versions::root_for(&gateway::install_root(), &choice), &lad);
    if !layout.node.exists() || !layout.openclaw_entry.exists() {
        return Err(err(
            "The assistant isn't installed on this server yet. Please tell your admin.",
        )
        .into());
    }
    gateway::write_config(&layout, port)
        .map_err(|_| err("Couldn't prepare your assistant's settings."))?;

    let mut child = spawn_gateway(&layout, port, &token)?;
    // The lock stays held until the gateway is ready, so two starts can't race;
    // `status` uses try_lock and reports "not running" meanwhile.
    let mut backup: Option<PathBuf> = None;
    let fail = |error: GatewayError, backup: &Option<PathBuf>| {
        release(correlation_id);
        StartFailure {
            error,
            backup: backup.clone(),
        }
    };
    loop {
        match gateway::wait_ready_or_exit(port, &mut child, Duration::from_secs(90)) {
            Startup::Ready => break,
            Startup::Exited(code) if needs_doctor(code, backup.is_some()) => {
                // ADR-025: snapshot first, then Doctor, then one retry.
                match gateway::backup_state(&layout.state_dir, &layout.backups_dir, &stamp()) {
                    Ok(b) => backup = Some(b),
                    Err(_) => return Err(fail(err("Couldn't back up your assistant's data before updating it. Free some disk space or tell your admin."), &None)),
                }
                if let Err(e) = run_doctor(&layout) {
                    return Err(fail(e, &backup));
                }
                child = match spawn_gateway(&layout, port, &token) {
                    Ok(c) => c,
                    Err(e) => return Err(fail(e, &backup)),
                };
            }
            Startup::Exited(_) => {
                return Err(fail(err("Your assistant stopped while starting. Try again; if it keeps happening, use Report a problem."), &backup));
            }
            Startup::TimedOut => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(fail(err("Your assistant didn't start in time. Try again; if it keeps happening, use Report a problem."), &backup));
            }
        }
    }
    *guard = Some(Running { port, token, child });
    Ok(GatewayStatus {
        running: true,
        port: Some(port),
    })
}

/// Exit code 78 → Doctor once; anything else (or a second 78) is a failure.
pub fn needs_doctor(code: Option<i32>, already_doctored: bool) -> bool {
    code == Some(gateway::EXIT_NEEDS_DOCTOR) && !already_doctored
}

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn spawn_gateway(layout: &Layout, port: u16, token: &str) -> Result<Child, GatewayError> {
    let mut cmd = Command::new(&layout.node);
    cmd.args(gateway::arguments(layout, port))
        .current_dir(&layout.state_dir) // controlled CWD: a .env in CWD would be read (OPENCLAW_NOTES §2)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (k, v) in gateway::environment(layout, token) {
        cmd.env(k, v);
    }
    no_window(&mut cmd);
    cmd.spawn()
        .map_err(|_| err("Couldn't start your assistant. Please tell your admin."))
}

fn stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs:012}") // zero-padded seconds sort by time
}

/// ADR-025: snapshot the state, then `openclaw doctor --fix --yes --non-interactive`
/// with the gateway stopped (it has exited), at most 5 minutes.
fn run_doctor(layout: &Layout) -> Result<(), GatewayError> {
    let mut cmd = Command::new(&layout.node);
    cmd.args(gateway::doctor_arguments(layout))
        .current_dir(&layout.state_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (k, v) in gateway::doctor_environment(layout) {
        cmd.env(k, v);
    }
    no_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|_| err("Couldn't update your assistant's data. Please tell your admin."))?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) if st.success() => return Ok(()),
            Ok(Some(_)) | Err(_) => {
                return Err(err("Your assistant's data needs a repair Off Manual couldn't do. Use Report a problem."))
            }
            Ok(None) if start.elapsed() > Duration::from_secs(300) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err("Updating your assistant's data took too long. Try again later."));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(500)),
        }
    }
}

fn release(correlation_id: &str) {
    let _ = agent_client::call("gateway.release", &json!({}), correlation_id);
}

// ---- restart to update (UPDATES.md §4, ADR-048) ----

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// Version this employee's gateway runs (None when `current` can't be resolved).
    pub running: Option<String>,
    /// Staged release, when installed on disk and different from the running one.
    pub available: Option<String>,
    pub severity: String,
    pub deadline_at: Option<String>,
}

pub fn update_status(correlation_id: &str) -> Result<UpdateStatus, GatewayError> {
    let r = agent_client::call("update.status", &json!({}), correlation_id)
        .map_err(|e| err(&e.message))?;
    let lad =
        local_app_data().ok_or_else(|| err("Your Windows profile folder couldn't be found."))?;
    let current = gateway::install_root();
    let running = versions::version_of(&versions::root_for(
        &current,
        &versions::load(&versions::choice_path(&lad)),
    ));
    let staged = r["staged"].as_str().unwrap_or_default().to_string();
    let base = versions::install_base(&current);
    let available = (versions::installed(&base, &staged)
        && running.as_deref() != Some(staged.as_str()))
    .then_some(staged);
    Ok(UpdateStatus {
        running,
        available,
        severity: r["severity"].as_str().unwrap_or_default().to_string(),
        deadline_at: r["deadlineAt"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    })
}

/// Switches this employee's gateway to `version`. On failure: restore the state
/// snapshot Doctor took (if any), go back to the previous choice and start again.
pub fn apply_update(
    state: &GatewayState,
    version: &str,
    correlation_id: &str,
) -> Result<GatewayStatus, GatewayError> {
    if !versions::valid_version(version) {
        return Err(err("Unknown version."));
    }
    let lad =
        local_app_data().ok_or_else(|| err("Your Windows profile folder couldn't be found."))?;
    let current = gateway::install_root();
    if !versions::installed(&versions::install_base(&current), version) {
        return Err(err(
            "That update isn't ready on this server yet. Try again later.",
        ));
    }
    let path = versions::choice_path(&lad);
    let before = versions::load(&path);
    let old = before
        .active
        .clone()
        .or_else(|| versions::version_of(&versions::root_for(&current, &before)));
    stop(state, correlation_id);
    let next = versions::Choice {
        active: Some(version.to_string()),
        previous: old,
    };
    versions::save(&path, &next).map_err(|_| err("Couldn't save the update choice. Try again."))?;
    match start_inner(state, correlation_id) {
        Ok(s) => Ok(s),
        Err(f) => {
            let state_dir = Layout::new(&current, &lad).state_dir;
            if let Some(b) = &f.backup {
                let _ = gateway::restore_backup(&state_dir, b, &stamp());
            }
            let _ = versions::save(&path, &before);
            Err(match start(state, correlation_id) {
                Ok(_) => err("The update didn't work, so Off Manual went back to the previous version. Please use Report a problem."),
                Err(_) => f.error,
            })
        }
    }
}

/// Stops the gateway and frees the lease.
pub fn stop(state: &GatewayState, correlation_id: &str) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut r) = guard.take() {
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }
    let _ = agent_client::call("gateway.release", &json!({}), correlation_id);
}

pub fn status(state: &GatewayState) -> GatewayStatus {
    let stopped = GatewayStatus {
        running: false,
        port: None,
    };
    // try_lock: a start in progress holds the lock for up to a few minutes.
    let Ok(mut guard) = state.0.try_lock() else {
        return stopped;
    };
    if let Some(r) = guard.as_mut() {
        if matches!(r.child.try_wait(), Ok(None)) {
            return GatewayStatus {
                running: true,
                port: Some(r.port),
            };
        }
    }
    stopped
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn doctor_only_once_and_only_for_78() {
        assert!(needs_doctor(Some(78), false));
        assert!(!needs_doctor(Some(78), true));
        assert!(!needs_doctor(Some(1), false));
        assert!(!needs_doctor(None, false));
    }

    #[test]
    fn status_of_a_fresh_state_is_stopped() {
        let s = GatewayState::default();
        assert_eq!(
            status(&s),
            GatewayStatus {
                running: false,
                port: None
            }
        );
    }

    #[test]
    fn start_reports_plain_errors_without_a_server_agent() {
        // No Server Agent in the test environment: the lease fails with a plain message.
        let s = GatewayState::default();
        let e = start(&s, "desk-test").unwrap_err();
        assert!(!e.message.is_empty());
        assert!(!e.message.contains("os error"));
        assert!(!status(&s).running);
    }
}
