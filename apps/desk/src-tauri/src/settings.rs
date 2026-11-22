//! The employee's own Desk settings (DATA_MODEL §3 `desk\settings.json`, ADR-066):
//! which side the panel docks to and an optional shorter lock time. The firm's
//! maximum lock time still applies (the UI uses the smaller one); nothing here can
//! weaken a firm rule.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const MAX_LOCK_MINUTES: u32 = 480;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    #[default]
    Right,
    Left,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    #[serde(default)]
    pub side: Side,
    /// Lock after this many idle minutes, if shorter than the firm's maximum.
    #[serde(default)]
    pub lock_minutes: Option<u32>,
}

impl Settings {
    /// Rejects values the UI should never send.
    pub fn validate(&self) -> Result<(), String> {
        match self.lock_minutes {
            Some(m) if m == 0 || m > MAX_LOCK_MINUTES => Err(format!(
                "Lock time must be between 1 and {MAX_LOCK_MINUTES} minutes."
            )),
            _ => Ok(()),
        }
    }
}

pub fn path_in(local_app_data: &Path) -> PathBuf {
    local_app_data
        .join("OffManual")
        .join("desk")
        .join("settings.json")
}

/// Reads the settings; a missing, unreadable or invalid file gives the defaults.
pub fn load(path: &Path) -> Settings {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Settings>(&b).ok())
        .filter(|s| s.validate().is_ok())
        .unwrap_or_default()
}

/// Validates and writes the settings atomically (temp file + rename).
pub fn save(path: &Path, s: &Settings) -> Result<(), String> {
    s.validate()?;
    let dir = path
        .parent()
        .ok_or("Your settings folder couldn't be found.")?;
    std::fs::create_dir_all(dir).map_err(|_| "Your settings couldn't be saved.".to_string())?;
    let body =
        serde_json::to_vec_pretty(s).map_err(|_| "Your settings couldn't be saved.".to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|_| "Your settings couldn't be saved.".to_string())?;
    std::fs::rename(&tmp, path).map_err(|_| "Your settings couldn't be saved.".to_string())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("om-settings-{n}-{}", std::process::id()))
    }

    #[test]
    fn defaults_when_missing_or_bad() {
        let dir = temp();
        let p = path_in(&dir);
        assert_eq!(load(&p), Settings::default());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"not json").unwrap();
        assert_eq!(load(&p), Settings::default());
        std::fs::write(&p, br#"{"side":"left","lockMinutes":0}"#).unwrap(); // invalid value
        assert_eq!(load(&p), Settings::default());
        std::fs::write(&p, br#"{"side":"left","extra":1}"#).unwrap(); // unknown field
        assert_eq!(load(&p), Settings::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = temp();
        let p = path_in(&dir);
        let s = Settings {
            side: Side::Left,
            lock_minutes: Some(5),
        };
        save(&p, &s).unwrap();
        assert_eq!(load(&p), s);
        assert!(std::fs::read_to_string(&p)
            .unwrap()
            .contains("\"lockMinutes\": 5"));
        assert!(save(
            &p,
            &Settings {
                side: Side::Right,
                lock_minutes: Some(481)
            }
        )
        .is_err());
        assert_eq!(load(&p), s); // a refused save leaves the file alone
        let _ = std::fs::remove_dir_all(&dir);
    }
}
