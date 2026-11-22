//! Which installed version each employee's gateway runs (UPDATES.md §4, ADR-048).
//!
//! The Server Agent stages verified releases into `<base>\versions\<v>`; Desk
//! switches one employee at a time ("Restart to update") by recording the chosen
//! version in `%LOCALAPPDATA%\OffManual\desk\version.json`. Without a choice the
//! gateway runs from `current` (the install's junction).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Choice {
    pub active: Option<String>,
    pub previous: Option<String>,
}

/// Strict release version: 1.2.3 or 1.2.3-rc.1 (never a path).
pub fn valid_version(v: &str) -> bool {
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit()))
        && pre.is_none_or(|p| {
            !p.is_empty()
                && p.len() <= 20
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        })
        && v.len() <= 40
}

/// `C:\Program Files\OffManual` (the parent of `current`).
pub fn install_base(current: &Path) -> PathBuf {
    current
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| current.to_path_buf())
}

pub fn version_dir(base: &Path, v: &str) -> PathBuf {
    base.join("versions").join(v)
}

/// A version is usable when its node and OpenClaw entry are on disk.
pub fn installed(base: &Path, v: &str) -> bool {
    if !valid_version(v) {
        return false;
    }
    let d = version_dir(base, v);
    d.join("node").join("node.exe").exists()
        && d.join("openclaw")
            .join("node_modules")
            .join("openclaw")
            .join("openclaw.mjs")
            .exists()
}

/// The root a gateway starts from: the chosen version if installed, else `current`.
pub fn root_for(current: &Path, choice: &Choice) -> PathBuf {
    let base = install_base(current);
    match &choice.active {
        Some(v) if installed(&base, v) => version_dir(&base, v),
        _ => current.to_path_buf(),
    }
}

/// The version a root runs: `versions\<v>` directly, or what `current` points to.
pub fn version_of(root: &Path) -> Option<String> {
    let resolved = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let name = resolved.file_name()?.to_string_lossy().to_string();
    let parent = resolved
        .parent()?
        .file_name()?
        .to_string_lossy()
        .to_string();
    (parent.eq_ignore_ascii_case("versions") && valid_version(&name)).then_some(name)
}

pub fn choice_path(local_app_data: &Path) -> PathBuf {
    local_app_data
        .join("OffManual")
        .join("desk")
        .join("version.json")
}

pub fn load(path: &Path) -> Choice {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Choice>(&b).ok())
        .map(|c| Choice {
            active: c.active.filter(|v| valid_version(v)),
            previous: c.previous.filter(|v| valid_version(v)),
        })
        .unwrap_or_default()
}

pub fn save(path: &Path, c: &Choice) -> std::io::Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(c).map_err(std::io::Error::other)?,
    )?;
    std::fs::rename(tmp, path)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("om-versions-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn fake_install(base: &Path, v: &str) {
        let d = version_dir(base, v);
        std::fs::create_dir_all(d.join("node")).unwrap();
        std::fs::write(d.join("node").join("node.exe"), "x").unwrap();
        let oc = d.join("openclaw").join("node_modules").join("openclaw");
        std::fs::create_dir_all(&oc).unwrap();
        std::fs::write(oc.join("openclaw.mjs"), "x").unwrap();
    }

    #[test]
    fn versions_are_strict() {
        for ok in ["1.2.3", "0.0.1", "10.20.30-rc.1", "1.0.0-beta-2"] {
            assert!(valid_version(ok), "{ok}");
        }
        for bad in [
            "",
            "1.2",
            "1.2.3.4",
            "..\\x",
            "1.2.3/..",
            "a.b.c",
            "1.2.3-",
            "1.2.3-\u{e9}",
        ] {
            assert!(!valid_version(bad), "{bad}");
        }
    }

    #[test]
    fn root_follows_an_installed_choice_only() {
        let base = tmp("root");
        let current = base.join("current");
        std::fs::create_dir_all(&current).unwrap();
        fake_install(&base, "1.2.0");
        let chosen = Choice {
            active: Some("1.2.0".into()),
            previous: None,
        };
        assert_eq!(root_for(&current, &chosen), version_dir(&base, "1.2.0"));
        let missing = Choice {
            active: Some("9.9.9".into()),
            previous: None,
        };
        assert_eq!(root_for(&current, &missing), current);
        assert_eq!(root_for(&current, &Choice::default()), current);
        assert_eq!(
            version_of(&version_dir(&base, "1.2.0")).as_deref(),
            Some("1.2.0")
        );
        assert_eq!(version_of(&current), None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn choice_round_trip_and_bad_files() {
        let d = tmp("choice");
        let p = choice_path(&d);
        assert_eq!(load(&p), Choice::default());
        let c = Choice {
            active: Some("1.3.0".into()),
            previous: Some("1.2.0".into()),
        };
        save(&p, &c).unwrap();
        assert_eq!(load(&p), c);
        std::fs::write(&p, r#"{"active":"..\\evil","previous":"1.2.0"}"#).unwrap();
        assert_eq!(
            load(&p),
            Choice {
                active: None,
                previous: Some("1.2.0".into())
            }
        );
        std::fs::write(&p, "not json").unwrap();
        assert_eq!(load(&p), Choice::default());
        let _ = std::fs::remove_dir_all(&d);
    }
}
