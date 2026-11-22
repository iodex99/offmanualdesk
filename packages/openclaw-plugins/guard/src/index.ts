// Guard plugin for OpenClaw. M0: identity and pure helpers only. The OpenClaw
// plugin entry (manifest + register function) is added once the plugin SDK
// shape is verified in docs/OPENCLAW_NOTES.md §4–§5 (M1) and built in M5.
//
// Rule (.claude/rules/openclaw.md): the guard fails closed. If it cannot reach the
// Server Agent or read policy, it rejects the turn with a plain message.

export const PLUGIN_ID = "offmanual-guard";

export { classifyError, classifyErrorText, deniedMessage, type AccessDenied } from "./access-denied.js";
