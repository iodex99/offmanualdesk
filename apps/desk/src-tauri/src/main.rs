// Off Manual Desk entry point. Release builds use the Windows GUI subsystem so no
// console window appears in the employee's RDP session.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_client;
mod gateway;
mod gateway_manager;
mod info;

use std::sync::Arc;

#[tauri::command]
fn app_info() -> info::AppInfo {
    info::AppInfo::current()
}

/// Calls the Server Agent over the pipe. Runs on a blocking thread so the UI stays responsive.
#[tauri::command]
async fn agent_call(
    method: String,
    params: serde_json::Value,
    correlation_id: String,
) -> Result<serde_json::Value, agent_client::AgentError> {
    tauri::async_runtime::spawn_blocking(move || {
        agent_client::call(&method, &params, &correlation_id)
    })
    .await
    .unwrap_or_else(|_| {
        Err(agent_client::AgentError {
            code: -1,
            message: "Off Manual hit a problem. Close it and open it again.".to_string(),
            data: None,
        })
    })
}

fn correlation(prefix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{prefix}-{nanos:x}")
}

#[tauri::command]
async fn gateway_start(
    state: tauri::State<'_, Arc<gateway_manager::GatewayState>>,
) -> Result<gateway_manager::GatewayStatus, gateway_manager::GatewayError> {
    let st = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        gateway_manager::start(&st, &correlation("desk-gw"))
    })
    .await
    .unwrap_or_else(|_| {
        Err(gateway_manager::GatewayError {
            message: "Off Manual hit a problem. Close it and open it again.".to_string(),
        })
    })
}

#[tauri::command]
async fn gateway_stop(
    state: tauri::State<'_, Arc<gateway_manager::GatewayState>>,
) -> Result<(), ()> {
    let st = Arc::clone(&state);
    let _ = tauri::async_runtime::spawn_blocking(move || {
        gateway_manager::stop(&st, &correlation("desk-gw"))
    })
    .await;
    Ok(())
}

#[tauri::command]
fn gateway_status(
    state: tauri::State<'_, Arc<gateway_manager::GatewayState>>,
) -> gateway_manager::GatewayStatus {
    gateway_manager::status(&state)
}

fn main() {
    // Every gateway Desk starts dies with Desk (OPENCLAW_NOTES §2: the gateway doesn't follow its parent).
    if !gateway::job::contain_self() {
        eprintln!("offmanual-desk: could not create the process job; gateways are stopped on exit instead");
    }
    let result = tauri::Builder::default()
        .manage(Arc::new(gateway_manager::GatewayState::default()))
        .invoke_handler(tauri::generate_handler![
            app_info,
            agent_call,
            gateway_start,
            gateway_stop,
            gateway_status
        ])
        .run(tauri::generate_context!());
    if let Err(err) = result {
        // No client data here: only the framework error. Structured logging lands in M4.
        eprintln!("offmanual-desk failed to start: {err}");
        std::process::exit(1);
    }
}
