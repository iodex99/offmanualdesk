// Off Manual Desk entry point. Release builds use the Windows GUI subsystem so no
// console window appears in the employee's RDP session.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod info;

#[tauri::command]
fn app_info() -> info::AppInfo {
    info::AppInfo::current()
}

fn main() {
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!());
    if let Err(err) = result {
        // No client data here: only the framework error. Structured logging lands in M4.
        eprintln!("offmanual-desk failed to start: {err}");
        std::process::exit(1);
    }
}
