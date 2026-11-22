import { invoke, isTauri } from "@tauri-apps/api/core";

export interface AppInfo {
  name: string;
  version: string;
  /** "tauri" inside the desktop app, "browser" in the Vite preview. */
  runtime: "tauri" | "browser";
}

/** Asks the Rust side for build info; falls back to a browser preview stub. */
export async function loadAppInfo(): Promise<AppInfo> {
  if (!isTauri()) {
    return { name: "Off Manual Desk", version: "dev", runtime: "browser" };
  }
  const info = await invoke<{ name: string; version: string }>("app_info");
  return { ...info, runtime: "tauri" };
}
