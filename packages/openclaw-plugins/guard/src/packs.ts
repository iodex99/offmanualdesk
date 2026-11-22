// Skill packs → tool allowlist (ADR-043). Pack definitions ship inside the signed
// release (`skills/packs.json`); the console only grants pack keys to employees. A
// tool that no granted pack lists is blocked before it runs. Fails closed: no pack
// file or no policy → no tools.
import { readFileSync } from "node:fs";

export interface PackDef {
  name: string;
  tools: string[];
}

export interface Packs {
  schema: 1;
  packs: Record<string, PackDef>;
}

const PACK_KEY = /^[a-z][a-z0-9-]{1,30}$/;
const TOOL = /^[a-z][a-z0-9_]{1,63}$/;
/** Aliases OpenClaw accepts for built-in tools (docs: `bash` is an alias for `exec`). */
const ALIASES: Record<string, string> = { bash: "exec" };

export function parsePacks(raw: unknown): Packs {
  const o = raw as Partial<Packs> | null;
  if (!o || o.schema !== 1 || !o.packs || typeof o.packs !== "object")
    throw new Error("packs.json: bad schema");
  const packs: Record<string, PackDef> = {};
  for (const [key, def] of Object.entries(o.packs)) {
    if (!PACK_KEY.test(key)) throw new Error(`packs.json: bad pack key ${key}`);
    const d = def as Partial<PackDef> | null;
    if (
      !d ||
      typeof d.name !== "string" ||
      !Array.isArray(d.tools) ||
      !d.tools.every((t) => typeof t === "string" && TOOL.test(t))
    ) {
      throw new Error(`packs.json: bad pack ${key}`);
    }
    packs[key] = { name: d.name, tools: [...d.tools] };
  }
  if (!packs.core) throw new Error("packs.json: core pack missing");
  return { schema: 1, packs };
}

export function loadPacks(path: string): Packs {
  return parsePacks(JSON.parse(readFileSync(path, "utf8")));
}

export interface PackPolicy {
  packs: string[];
  telegramAllowedPacks?: string[];
}

/**
 * Tools an employee may use on a channel. On Telegram only packs the firm allows
 * there apply (core always, so Telegram can answer at all).
 */
export function allowedTools(defs: Packs, policy: PackPolicy, channel: "desk" | "telegram"): Set<string> {
  let keys = policy.packs;
  if (channel === "telegram") {
    const ok = new Set(["core", ...(policy.telegramAllowedPacks ?? [])]);
    keys = keys.filter((k) => ok.has(k));
  }
  const out = new Set<string>();
  for (const k of keys) for (const t of defs.packs[k]?.tools ?? []) out.add(t);
  return out;
}

export const MSG_TOOL_NOT_IN_PACK =
  "That isn't part of your Off Manual access, so it wasn't done. Tell the user their admin can add it if they need it.";
export const MSG_POLICY_UNAVAILABLE =
  "Off Manual couldn't check your access just now, so nothing was done. Tell the user to try again in a minute.";

export function normalizeTool(name: string): string {
  const n = name.toLowerCase();
  return ALIASES[n] ?? n;
}

/** Block reason for a tool call, or undefined when allowed. */
export function packBlockReason(toolName: string, allowed: Set<string> | null): string | undefined {
  if (!allowed) return MSG_POLICY_UNAVAILABLE;
  return allowed.has(normalizeTool(toolName)) ? undefined : MSG_TOOL_NOT_IN_PACK;
}

/** Caches policy.get for at most maxAgeMs. */
export class PolicyCache {
  private value: { at: number; policy: PackPolicy } | null = null;
  constructor(private readonly maxAgeMs = 30_000) {}
  get(now: number): PackPolicy | null {
    return this.value && now - this.value.at <= this.maxAgeMs ? this.value.policy : null;
  }
  set(policy: PackPolicy, now: number): void {
    this.value = { at: now, policy };
  }
}

/** Validates a policy.get reply's pack fields. */
export function packPolicyFrom(reply: unknown): PackPolicy | null {
  const r = reply as { packs?: unknown; telegramAllowedPacks?: unknown } | null;
  if (!r || !Array.isArray(r.packs) || !r.packs.every((p) => typeof p === "string")) return null;
  const tg = Array.isArray(r.telegramAllowedPacks)
    ? r.telegramAllowedPacks.filter((p): p is string => typeof p === "string")
    : [];
  return { packs: r.packs as string[], telegramAllowedPacks: tg };
}
