// Off Manual Desk entry point. Release builds use the Windows GUI subsystem so no
// console window appears in the employee's RDP session.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_client;
mod chat;
mod dpapi;
mod gateway;
mod gateway_client;
mod gateway_manager;
mod idle;
mod info;
mod instance;
mod versions;

use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

/// Seconds since the last keyboard/mouse input in this Windows session (idle lock, F3).
#[tauri::command]
fn idle_seconds() -> Option<u32> {
    idle::idle_seconds()
}

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
    step_up_grant: Option<String>,
) -> Result<serde_json::Value, gateway_manager::GatewayError> {
    let p = chat::decide_params(&ids, &decision, params, step_up_grant)?;
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

/// Staged release vs. the version this employee runs (UPDATES.md §4).
#[tauri::command]
async fn update_status() -> Result<gateway_manager::UpdateStatus, gateway_manager::GatewayError> {
    tauri::async_runtime::spawn_blocking(|| gateway_manager::update_status(&correlation("desk-up")))
        .await
        .unwrap_or_else(|_| Err(crashed()))
}

/// Restart to update: switch this employee's gateway to `version`, rolling back on failure.
#[tauri::command]
async fn update_apply(
    gw: GwState<'_>,
    version: String,
) -> Result<gateway_manager::GatewayStatus, gateway_manager::GatewayError> {
    let gw = Arc::clone(&gw);
    tauri::async_runtime::spawn_blocking(move || {
        gateway_manager::apply_update(&gw, &version, &correlation("desk-up"))
    })
    .await
    .unwrap_or_else(|_| Err(crashed()))
}

/// "Ask Off Manual" requests from Explorer waiting for the UI (ADR-059).
#[derive(Default)]
struct InboxState(Mutex<Vec<instance::Request>>);

/// The UI takes waiting requests on start and after each `om-inbox` signal.
#[tauri::command]
fn inbox_take(state: tauri::State<'_, Arc<InboxState>>) -> Vec<instance::Request> {
    state
        .0
        .lock()
        .map(|mut v| std::mem::take(&mut *v))
        .unwrap_or_default()
}

/// A later launch in this session: bring the window forward and queue "ask" requests.
fn deliver(app: &tauri::AppHandle, reqs: Vec<instance::Request>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let asks: Vec<_> = reqs
        .into_iter()
        .filter(|r| matches!(r, instance::Request::Ask { .. }))
        .collect();
    if asks.is_empty() {
        return;
    }
    if let Some(st) = app.try_state::<Arc<InboxState>>() {
        if let Ok(mut v) = st.0.lock() {
            v.extend(asks);
        }
    }
    let _ = app.emit(instance::INBOX_SIGNAL, ());
}

fn main() {
    // One Desk per Windows session (ADR-059): a second launch hands its request over and exits.
    let request = instance::request_from_args(std::env::args().skip(1));
    let inbox =
        std::env::var_os("LOCALAPPDATA").map(|d| instance::inbox_dir(std::path::Path::new(&d)));
    let _instance = match instance::claim() {
        instance::Claim::Second => {
            if let Some(dir) = &inbox {
                let _ = instance::forward(dir, &request);
            }
            return;
        }
        instance::Claim::First(h) => Some(h),
        instance::Claim::Unknown => None,
    };
    let first = InboxState::default();
    if let (Ok(mut v), instance::Request::Ask { .. }) = (first.0.lock(), &request) {
        v.push(request.clone());
    }
    // Every gateway Desk starts dies with Desk (OPENCLAW_NOTES §2: the gateway doesn't follow its parent).
    if !gateway::job::contain_self() {
        eprintln!("offmanual-desk: could not create the process job; gateways are stopped on exit instead");
    }
    let result = tauri::Builder::default()
        .manage(Arc::new(gateway_manager::GatewayState::default()))
        .manage(Arc::new(chat::ChatState::default()))
        .manage(Arc::new(first))
        .setup(move |app| {
            let handle = app.handle().clone();
            if let Some(dir) = inbox {
                instance::listen(dir, move |reqs| deliver(&handle, reqs));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            idle_seconds,
            agent_call,
            gateway_start,
            gateway_stop,
            gateway_status,
            chat_send,
            chat_abort,
            review_list,
            review_decide,
            update_status,
            update_apply,
            inbox_take
        ])
        .run(tauri::generate_context!());
    if let Err(err) = result {
        // No client data here: only the framework error. Structured logging lands in M4.
        eprintln!("offmanual-desk failed to start: {err}");
        std::process::exit(1);
    }
}
