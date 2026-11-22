//! Session idle time for the idle lock (ARCHITECTURE F3). GetLastInputInfo is
//! per session, which is what an RDS host needs: each employee's Desk sees only
//! their own keyboard and mouse input. FFI verified against windows-sys 0.61.2
//! (`Win32/UI/Input/KeyboardAndMouse`, `Win32/System/SystemInformation`).

/// Milliseconds between two tick counts, correct across the 49.7-day wrap.
pub fn elapsed_ms(now: u32, last_input: u32) -> u32 {
    now.wrapping_sub(last_input)
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod platform {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    pub fn idle_ms() -> Option<u32> {
        let mut info = LASTINPUTINFO {
            cbSize: u32::try_from(std::mem::size_of::<LASTINPUTINFO>()).ok()?,
            dwTime: 0,
        };
        // SAFETY: info is a valid, initialised LASTINPUTINFO with cbSize set.
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            return None;
        }
        // SAFETY: no arguments; returns the tick count.
        let now = unsafe { GetTickCount() };
        Some(super::elapsed_ms(now, info.dwTime))
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn idle_ms() -> Option<u32> {
        None
    }
}

/// Seconds since the last keyboard or mouse input in this Windows session.
/// None when it can't be read (the UI then falls back to its own activity timer).
pub fn idle_seconds() -> Option<u32> {
    platform::idle_ms().map(|ms| ms / 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elapsed_handles_wrap() {
        assert_eq!(elapsed_ms(5_000, 2_000), 3_000);
        assert_eq!(elapsed_ms(100, u32::MAX - 899), 1_000);
    }

    #[cfg(windows)]
    #[test]
    fn idle_seconds_reads_on_windows() {
        // A CI runner has a session; the value is small or large but must be readable.
        assert!(idle_seconds().is_some());
    }
}
