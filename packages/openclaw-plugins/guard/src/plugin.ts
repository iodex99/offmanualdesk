// OpenClaw entry for the guard plugin (docs/OPENCLAW_NOTES.md §4–§5).
//
//  * before_agent_run: lock / lockout / Telegram-window gate, fail closed (F5, F8).
//  * agent tool-result middleware: rewrites an OS access denial before the model sees
//    it and marks the run (ADR-022); audit event to the Server Agent.
//  * before_tool_call: once a run hit a denial, every further tool call is blocked.
//  * before_install: every skill/plugin install is blocked (ADR-024).
//  * review queue (ADR-028, ADR-041): proposal tool offmanual_delete_files, Desk-only
//    gateway methods offmanual.review.list / offmanual.review.decide, and a
//    before_tool_call check that blocks built-in deletes that would skip the queue.
//  * skill packs (ADR-043): before_tool_call allows only tools listed by the employee's
//    granted packs in the release's skills/packs.json (Telegram: firm-allowed packs only).
import { join } from "node:path";
import {
  PolicyCache,
  allowedTools,
  loadPacks,
  packBlockReason,
  packPolicyFrom,
  type PackPolicy,
  type Packs,
} from "./packs.js";
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
import { deleteFiles, MAX_DELETE_FILES } from "./delete-files.js";
import { ReviewQueue, ReviewStore, bypassBlockReason, queuedText, type ActionKind } from "./review.js";

export const INSTALL_BLOCK_REASON = "Installs are managed by Off Manual. Ask your admin.";
export const DELETE_TOOL = "offmanual_delete_files";
export const DEFAULT_PACKS = String.raw`C:\Program Files\OffManual\current\skills\packs.json`;
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
    const cfg = (api.pluginConfig ?? {}) as { bridgeCommand?: string; packsPath?: string };
    const bridge = new AgentBridge(cfg.bridgeCommand || DEFAULT_BRIDGE);
    const lockCache = new LockCache(5000);
    const stopped = new StoppedRuns();
    const policyCache = new PolicyCache(30_000);
    let packs: Packs | null = null;
    try {
      packs = loadPacks(cfg.packsPath || DEFAULT_PACKS);
    } catch {
      api.logger.error("offmanual-guard: skills/packs.json unreadable; every tool call will be refused");
    }
    const packPolicy = async (): Promise<PackPolicy | null> => {
      const now = Date.now();
      const cached = policyCache.get(now);
      if (cached) return cached;
      try {
        const p = packPolicyFrom(await bridge.call("policy.get"));
        if (p) policyCache.set(p, now);
        return p;
      } catch {
        return null; // fail closed
      }
    };
    const audit = (category: string, action: string, result: string, target = "") =>
      bridge.call("audit.append", { category, action, target, result }).catch(() => undefined);
    const queue = new ReviewQueue(
      new ReviewStore(join(api.runtime.state.resolveStateDir(), "plugins", PLUGIN_ID, "review.json")),
      [deleteFiles as unknown as ActionKind],
      (category, action, result) => void audit(category, action, result),
    );

    api.registerTool({
      name: DELETE_TOOL,
      label: "Delete files (needs approval)",
      description:
        "Ask for files to be deleted. Nothing is deleted now: the request waits in the Review tab of " +
        "Off Manual Desk until the user approves it. Use this for every delete.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["paths", "reason"],
        properties: {
          paths: {
            type: "array",
            minItems: 1,
            maxItems: MAX_DELETE_FILES,
            items: {
              type: "string",
              description: String.raw`Full Windows path, e.g. C:\Clients\ABC\old.pdf`,
            },
          },
          reason: { type: "string", description: "Why these files should be deleted, in a few words." },
        },
      },
      async execute(_toolCallId: string, params: unknown) {
        const p = await queue.propose("delete_files", params);
        return { content: [{ type: "text" as const, text: queuedText(p) }], details: { reviewId: p.id } };
      },
    });

    // Desk's Review tab. Scope operator.approvals: the Telegram relay doesn't request it,
    // and the agent can't reach gateway methods (the `gateway` tool is denied).
    api.registerGatewayMethod(
      "offmanual.review.list",
      async ({ respond }) => {
        respond(true, { items: await queue.store.list() });
      },
      { scope: "operator.approvals" },
    );
    api.registerGatewayMethod(
      "offmanual.review.decide",
      async ({ params, respond }) => {
        const ids = params.ids;
        const decision = params.decision;
        if (
          !Array.isArray(ids) ||
          ids.length === 0 ||
          ids.length > 100 ||
          !ids.every((x) => typeof x === "string" && /^\d{1,9}$/.test(x)) ||
          (decision !== "approve" && decision !== "reject") ||
          (params.params !== undefined && ids.length !== 1)
        ) {
          respond(false, undefined, { code: "INVALID_REQUEST", message: "invalid params" });
          return;
        }
        respond(true, { results: await queue.decide(ids as string[], decision, params.params) });
      },
      { scope: "operator.approvals" },
    );

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

    api.on("before_tool_call", async (event, ctx) => {
      if (stopped.isStopped(event.runId)) return { block: true, blockReason: STOPPED_BLOCK_REASON };
      const policy = packs ? await packPolicy() : null;
      const allowed =
        packs && policy ? allowedTools(packs, policy, channelOf(ctx.sessionKey, ctx.channelId)) : null;
      const notInPack = packBlockReason(event.toolName, allowed);
      if (notInPack) {
        void audit("tool_blocked", "not_in_pack", "blocked");
        return { block: true, blockReason: notInPack };
      }
      const bypass = bypassBlockReason(event.toolName, event.params);
      if (bypass) {
        void audit("tool_blocked", "delete_without_review", "blocked");
        return { block: true, blockReason: bypass };
      }
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
