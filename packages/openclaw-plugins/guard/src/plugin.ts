// OpenClaw entry for the guard plugin (docs/OPENCLAW_NOTES.md §4: manifest
// openclaw.plugin.json + package.json "openclaw.extensions" → dist/plugin.js,
// default export from definePluginEntry, register(api) synchronous).
//
// M1 scope: proves the packaging and SDK typing, and blocks every skill/plugin
// install (ADR-024 layer; `before_install` → { block, blockReason }, §7). Lock,
// skill packs, access-denied middleware and the review queue arrive in M5
// (ADR-022, ADR-028). Until then the guard must not be relied on for policy.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { PLUGIN_ID } from "./index.js";

export const INSTALL_BLOCK_REASON = "Installs are managed by Off Manual. Ask your admin.";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Off Manual Guard",
  description: "Lock, policy, review queue and access-denied enforcement for Off Manual Desk.",
  register(api) {
    api.on("before_install", () => ({ block: true, blockReason: INSTALL_BLOCK_REASON }));
  },
});
