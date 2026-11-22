//! Docked panel (PRODUCT: "Docked panel, hotkey"; ADR-064): at start Desk sits along the
//! right edge of the monitor's work area (above the taskbar), full height. The employee
//! can move or resize it afterwards.

/// Logical width of the panel (matches tauri.conf.json).
pub const PANEL_WIDTH: f64 = 420.0;
const MIN_WIDTH: f64 = 360.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// The docked rectangle in physical pixels for a work area and DPI scale. The width is
/// the panel width scaled, never more than half the work area, never less than the
/// minimum (unless the work area itself is smaller).
pub fn docked(work: Rect, scale: f64, side: crate::settings::Side) -> Rect {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let half = f64::from(work.width) / 2.0;
    let want = (PANEL_WIDTH * scale).min(half).max(MIN_WIDTH * scale);
    let width = (want.round() as u32).min(work.width);
    let x = match side {
        crate::settings::Side::Right => work.x + i32::try_from(work.width - width).unwrap_or(0),
        crate::settings::Side::Left => work.x,
    };
    Rect {
        x,
        y: work.y,
        width,
        height: work.height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Side;
    const R: Side = Side::Right;

    #[test]
    fn left_side() {
        let work = Rect {
            x: 1920,
            y: 0,
            width: 1280,
            height: 984,
        };
        let r = docked(work, 1.0, Side::Left);
        assert_eq!((r.x, r.width), (1920, 420));
    }

    #[test]
    fn right_edge_full_height() {
        let work = Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };
        assert_eq!(
            docked(work, 1.0, R),
            Rect {
                x: 1500,
                y: 0,
                width: 420,
                height: 1040
            }
        );
        // 150 % scaling: 630 physical pixels wide.
        assert_eq!(
            docked(work, 1.5, R),
            Rect {
                x: 1290,
                y: 0,
                width: 630,
                height: 1040
            }
        );
    }

    #[test]
    fn second_monitor_and_top_taskbar() {
        let work = Rect {
            x: 1920,
            y: 40,
            width: 1280,
            height: 984,
        };
        assert_eq!(
            docked(work, 1.0, R),
            Rect {
                x: 2780,
                y: 40,
                width: 420,
                height: 984
            }
        );
    }

    #[test]
    fn small_and_odd_screens() {
        // Narrow RDP window: half the width would be under the minimum, so the minimum wins.
        let work = Rect {
            x: 0,
            y: 0,
            width: 640,
            height: 480,
        };
        assert_eq!(
            docked(work, 1.0, R),
            Rect {
                x: 280,
                y: 0,
                width: 360,
                height: 480
            }
        );
        // Tinier than the minimum: never wider than the work area.
        let tiny = Rect {
            x: 0,
            y: 0,
            width: 300,
            height: 200,
        };
        assert_eq!(docked(tiny, 1.0, R).width, 300);
        assert_eq!(docked(tiny, 1.0, R).x, 0);
        // Nonsense scale falls back to 1.
        assert_eq!(docked(work, f64::NAN, R).width, 360);
        assert_eq!(
            docked(
                Rect {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080
                },
                0.0,
                R
            )
            .width,
            420
        );
    }
}
