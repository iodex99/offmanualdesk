//! Build information returned to the UI by the `app_info` command.

use serde::Serialize;

/// Name of the Server Agent pipe (docs/ARCHITECTURE.md §3.1). Used from M4.
#[allow(dead_code)]
pub const PIPE_NAME: &str = r"\\.\pipe\offmanual-agent";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

impl AppInfo {
    pub fn current() -> Self {
        Self {
            name: "Off Manual Desk".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_reports_package_version() {
        let info = AppInfo::current();
        assert_eq!(info.name, "Off Manual Desk");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn serialises_to_the_shape_the_ui_expects() {
        let json = serde_json::to_value(AppInfo::current()).unwrap_or_default();
        let obj = json.as_object().map(|o| {
            let mut k: Vec<_> = o.keys().cloned().collect();
            k.sort();
            k
        });
        assert_eq!(obj, Some(vec!["name".to_string(), "version".to_string()]));
    }

    #[test]
    fn pipe_name_matches_architecture() {
        assert_eq!(PIPE_NAME, "\\\\.\\pipe\\offmanual-agent");
    }
}
