// Off Manual Desk entry point. Release builds use the Windows GUI subsystem so no
// console window appears in the employee's RDP session.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_client;
mod info;

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

fn main() {
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_info, agent_call])
        .run(tauri::generate_context!());
    if let Err(err) = result {
        // No client data here: only the framework error. Structured logging lands in M4.
        eprintln!("offmanual-desk failed to start: {err}");
        std::process::exit(1);
    }
}
