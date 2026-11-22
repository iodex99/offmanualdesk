// The employee's own Desk settings (ADR-066): panel side and an optional shorter lock
// time. Saved by Rust in %LOCALAPPDATA%\OffManual\desk\settings.json.
import { invoke, isTauri } from "@tauri-apps/api/core";

export interface DeskSettings {
  side: "right" | "left";
  lockMinutes: number | null;
}

export const DEFAULT_SETTINGS: DeskSettings = { side: "right", lockMinutes: null };

export interface SettingsApi {
  get(): Promise<DeskSettings>;
  set(s: DeskSettings): Promise<void>;
}

export const tauriSettings: SettingsApi = {
  async get() {
    if (!isTauri()) return DEFAULT_SETTINGS;
    return invoke<DeskSettings>("settings_get");
  },
  async set(value) {
    if (!isTauri()) return;
    await invoke("settings_set", { value });
  },
};

/** The lock time that applies: the employee's own if it is shorter than the firm's maximum. */
export function effectiveLockMinutes(firmMax: number, own: number | null | undefined): number {
  return typeof own === "number" && Number.isFinite(own) && own >= 1 && own < firmMax
    ? Math.floor(own)
    : firmMax;
}

/** Choices offered: common steps under the firm's maximum, plus the maximum itself. */
export function lockChoices(firmMax: number): number[] {
  return [...[5, 10, 15, 30, 60].filter((m) => m < firmMax), firmMax];
}
