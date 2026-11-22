// OpenClaw entry for the guard plugin (docs/OPENCLAW_NOTES.md §4–§5).
//
//  * before_agent_run: lock / lockout / Telegram-window gate, fail closed (F5, F8).
//  * agent tool-result middleware: rewrites an OS access denial before the model sees
//    it and marks the run (ADR-022); audit event to the Server Agent.
//  * before_tool_call: once a run hit a denial, every further tool call is blocked.
//  * before_install: every skill/plugin install is blocked (ADR-024).
//
// Skill packs and the review queue (ADR-028) are next in M5.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { AgentBridge } from "./agent-bridge.js";
import {
  LockCache,
  STOPPED_BLOCK_REASON,
  StoppedRuns,
  deniedInResult,
  deniedResult,
  lockGate,
  targetFromArgs,
  type LockStatus,
} from "./gates.js";
import { PLUGIN_ID } from "./index.js";

export const INSTALL_BLOCK_REASON = "Installs are managed by Off Manual. Ask your admin.";
export const DEFAULT_BRIDGE = String.raw`C:\Program Files\OffManual\current\server-agent.exe`;

/** Telegram turns arrive on a dedicated session key from the Server Agent (ADR-023). */
export function channelOf(
  sessionKey: string | undefined,
  channelId: string | undefined,
): "desk" | "telegram" {
  return channelId === "telegram" || (sessionKey ?? "").includes(":telegram") ? "telegram" : "desk";
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Off Manual Guard",
  description: "Lock, policy, review queue and access-denied enforcement for Off Manual Desk.",
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as { bridgeCommand?: string };
    const bridge = new AgentBridge(cfg.bridgeCommand || DEFAULT_BRIDGE);
    const lockCache = new LockCache(5000);
    const stopped = new StoppedRuns();

    api.on("before_agent_run", async (event, ctx) => {
      const now = Date.now();
      let status = lockCache.get(now);
      if (!status) {
        try {
          status = (await bridge.call("lock.get")) as LockStatus;
          lockCache.set(status, now);
        } catch {
          status = null; // fail closed below
        }
      }
      const d = lockGate(status, channelOf(ctx.sessionKey, event.channelId), new Date(now));
      return d.outcome === "pass"
        ? { outcome: "pass" }
        : { outcome: "block", reason: d.reason, message: d.message };
    });

    api.registerAgentToolResultMiddleware(
      async (event, ctx) => {
        const denial = deniedInResult(event.isError, event.result);
        if (!denial) return undefined;
        if (ctx.runId) stopped.stop(ctx.runId, Date.now());
        bridge
          .call("audit.append", {
            category: "access_denied",
            action:
              event.toolName
                .toLowerCase()
                .replace(/[^a-z0-9_.-]/g, "_")
                .slice(0, 48) || "tool",
            target: targetFromArgs(event.args),
            result: "denied",
          })
          .catch(() => undefined); // audit is best effort; the denial itself is already enforced
        return { result: deniedResult(denial) };
      },
      { runtimes: ["openclaw"] },
    );

    api.on("before_tool_call", (event) => {
      if (stopped.isStopped(event.runId)) return { block: true, blockReason: STOPPED_BLOCK_REASON };
      return undefined;
    });

    api.on("agent_end", (event) => {
      stopped.end(event.runId);
    });

    api.on("before_install", () => ({ block: true, blockReason: INSTALL_BLOCK_REASON }));

    api.registerService({
      id: "offmanual-guard-bridge",
      start: async () => undefined,
      stop: async () => bridge.close(),
    });
  },
});
