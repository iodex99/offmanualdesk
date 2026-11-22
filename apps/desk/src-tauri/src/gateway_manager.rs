//! Starts and stops the employee's gateway (F4 steps 1–5). The token stays in Rust
//! memory; the UI only ever sees status.

use crate::agent_client;
use crate::gateway::{self, Layout};
use serde::Serialize;
use serde_json::json;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

pub struct Running {
    pub port: u16,
    /// Used by the chat client (ADR-021, next M4 slice); never sent to the UI.
    #[allow(dead_code)]
    pub token: String,
    child: Child,
}

#[derive(Default)]
pub struct GatewayState(pub Mutex<Option<Running>>);

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

/// F4: lease → config → spawn → readiness. Idempotent while a gateway is running.
pub fn start(state: &GatewayState, correlation_id: &str) -> Result<GatewayStatus, GatewayError> {
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
    let layout = Layout::new(&gateway::install_root(), &lad);
    if !layout.node.exists() || !layout.openclaw_entry.exists() {
        return Err(err(
            "The assistant isn't installed on this server yet. Please tell your admin.",
        ));
    }
    gateway::write_config(&layout, port)
        .map_err(|_| err("Couldn't prepare your assistant's settings."))?;

    let mut cmd = Command::new(&layout.node);
    cmd.args(gateway::arguments(&layout, port))
        .current_dir(&layout.state_dir) // controlled CWD: a .env in CWD would be read (OPENCLAW_NOTES §2)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (k, v) in gateway::environment(&layout, &token) {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd
        .spawn()
        .map_err(|_| err("Couldn't start your assistant. Please tell your admin."))?;
    *guard = Some(Running { port, token, child });
    drop(guard);

    if !gateway::wait_ready(port, Duration::from_secs(90)) {
        stop(state, correlation_id);
        return Err(err("Your assistant didn't start in time. Try again; if it keeps happening, use Report a problem."));
    }
    Ok(GatewayStatus {
        running: true,
        port: Some(port),
    })
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
    match state.0.lock() {
        Ok(mut g) => match g.as_mut() {
            Some(r) if matches!(r.child.try_wait(), Ok(None)) => GatewayStatus {
                running: true,
                port: Some(r.port),
            },
            _ => GatewayStatus {
                running: false,
                port: None,
            },
        },
        Err(_) => GatewayStatus {
            running: false,
            port: None,
        },
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

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
