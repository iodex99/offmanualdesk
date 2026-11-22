// channel-relay plugin for OpenClaw: carries Telegram messages between the employee's
// gateway and the Server Agent (which owns the firm's single bot, ADR-005) over
// \\.\pipe\offmanual-agent using telegram.subscribe / telegram.send.
//
// M0: identity only. The channel interface is verified in docs/OPENCLAW_NOTES.md §6
// (M1) and implemented in M6.
import type { PipeMethod } from "@offmanual/shared-schema";

export const PLUGIN_ID = "offmanual-channel-relay";
export const CHANNEL_ID = "offmanual-telegram";

/** The only pipe methods this plugin may call. */
export const RELAY_METHODS = ["telegram.subscribe", "telegram.send"] as const satisfies readonly PipeMethod[];
