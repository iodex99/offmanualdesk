// Off Manual Desk entry point. Release builds use the Windows GUI subsystem so no
// console window appears in the employee's RDP session.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_client;
mod chat;
mod dpapi;
mod gateway;
mod gateway_client;
mod gateway_manager;
mod info;

use std::sync::Arc;
use tauri::Emitter;

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

type GwState<'a> = tauri::State<'a, Arc<gateway_manager::GatewayState>>;
type ChatSt<'a> = tauri::State<'a, Arc<chat::ChatState>>;

fn crashed() -> gateway_manager::GatewayError {
    gateway_manager::GatewayError {
        message: "Off Manual hit a problem. Close it and open it again.".to_string(),
    }
}

fn sink_for(app: tauri::AppHandle) -> gateway_client::EventSink {
    chat::ui_sink(move |v| {
        let _ = app.emit(chat::CHAT_EVENT, v);
    })
}

/// Sends a chat message to the employee's gateway; replies arrive as `om-chat` events.
#[tauri::command]
async fn chat_send(
    app: tauri::AppHandle,
    gw: GwState<'_>,
    st: ChatSt<'_>,
    message: String,
) -> Result<String, gateway_manager::GatewayError> {
    let (gw, st) = (Arc::clone(&gw), Arc::clone(&st));
    tauri::async_runtime::spawn_blocking(move || chat::send(&gw, &st, sink_for(app), &message))
        .await
        .unwrap_or_else(|_| Err(crashed()))
}

#[tauri::command]
async fn chat_abort(
    app: tauri::AppHandle,
    gw: GwState<'_>,
    st: ChatSt<'_>,
    run_id: Option<String>,
) -> Result<(), gateway_manager::GatewayError> {
    let (gw, st) = (Arc::clone(&gw), Arc::clone(&st));
    tauri::async_runtime::spawn_blocking(move || {
        chat::abort(&gw, &st, sink_for(app), run_id.as_deref())
    })
    .await
    .unwrap_or_else(|_| Err(crashed()))
}

/// Review tab (ADR-041): the guard's `offmanual.review.list`.
#[tauri::command]
async fn review_list(
    app: tauri::AppHandle,
    gw: GwState<'_>,
    st: ChatSt<'_>,
) -> Result<serde_json::Value, gateway_manager::GatewayError> {
    let (gw, st) = (Arc::clone(&gw), Arc::clone(&st));
    tauri::async_runtime::spawn_blocking(move || {
        chat::with_client(&gw, &st, sink_for(app), |c| {
            c.request(
                "offmanual.review.list",
                serde_json::json!({}),
                std::time::Duration::from_secs(15),
            )
        })
    })
    .await
    .unwrap_or_else(|_| Err(crashed()))
}

/// Review tab: approve or reject items (an edit replaces one item's params).
#[tauri::command]
async fn review_decide(
    app: tauri::AppHandle,
    gw: GwState<'_>,
    st: ChatSt<'_>,
    ids: Vec<String>,
    decision: String,
    params: Option<serde_json::Value>,
) -> Result<serde_json::Value, gateway_manager::GatewayError> {
    let p = chat::decide_params(&ids, &decision, params)?;
    let (gw, st) = (Arc::clone(&gw), Arc::clone(&st));
    tauri::async_runtime::spawn_blocking(move || {
        chat::with_client(&gw, &st, sink_for(app), |c| {
            // Executing approved actions can take a while (e.g. many files).
            c.request(
                "offmanual.review.decide",
                p,
                std::time::Duration::from_secs(120),
            )
        })
    })
    .await
    .unwrap_or_else(|_| Err(crashed()))
}

fn main() {
    // Every gateway Desk starts dies with Desk (OPENCLAW_NOTES §2: the gateway doesn't follow its parent).
    if !gateway::job::contain_self() {
        eprintln!("offmanual-desk: could not create the process job; gateways are stopped on exit instead");
    }
    let result = tauri::Builder::default()
        .manage(Arc::new(gateway_manager::GatewayState::default()))
        .manage(Arc::new(chat::ChatState::default()))
        .invoke_handler(tauri::generate_handler![
            app_info,
            agent_call,
            gateway_start,
            gateway_stop,
            gateway_status,
            chat_send,
            chat_abort,
            review_list,
            review_decide
        ])
        .run(tauri::generate_context!());
    if let Err(err) = result {
        // No client data here: only the framework error. Structured logging lands in M4.
        eprintln!("offmanual-desk failed to start: {err}");
        std::process::exit(1);
    }
}
