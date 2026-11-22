//! Global hotkey Ctrl+Alt+O brings Desk forward from any app (PRODUCT: "Docked panel,
//! hotkey"; ADR-064). RegisterHotKey with a NULL window posts WM_HOTKEY to the
//! registering thread's queue, so a dedicated thread registers and runs GetMessageW.
//! Hotkeys belong to the session's desktop, so each RDS session has its own [A L8].
//! FFI verified against windows-sys 0.61.2 (`Win32/UI/Input/KeyboardAndMouse`,
//! `Win32/UI/WindowsAndMessaging`).

/// Shown to the employee (quick start guide).
pub const LABEL: &str = "Ctrl+Alt+O";

/// Starts the hotkey thread. Returns false when the hotkey can't be registered (another
/// app in this session holds it); Desk still works from the taskbar.
pub fn spawn<F>(on_press: F) -> bool
where
    F: Fn() + Send + 'static,
{
    platform::spawn(on_press)
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod platform {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, VK_O,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

    const ID: i32 = 0x4F4D; // "OM"

    pub fn spawn<F>(on_press: F) -> bool
    where
        F: Fn() + Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            // SAFETY: NULL window = post WM_HOTKEY to this thread; constant id and key.
            let ok = unsafe {
                RegisterHotKey(
                    std::ptr::null_mut(),
                    ID,
                    MOD_CONTROL | MOD_ALT | MOD_NOREPEAT,
                    u32::from(VK_O),
                )
            } != 0;
            let _ = tx.send(ok);
            if !ok {
                return;
            }
            let mut msg = MSG::default();
            loop {
                // SAFETY: msg is a valid MSG; NULL window = any message for this thread.
                let r = unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) };
                if r == 0 || r == -1 {
                    break; // WM_QUIT or error
                }
                if msg.message == WM_HOTKEY && msg.wParam == ID as usize {
                    on_press();
                }
            }
            // SAFETY: unregister the id this thread registered.
            unsafe { UnregisterHotKey(std::ptr::null_mut(), ID) };
        });
        rx.recv().unwrap_or(false)
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn spawn<F>(_on_press: F) -> bool
    where
        F: Fn() + Send + 'static,
    {
        false
    }
}
