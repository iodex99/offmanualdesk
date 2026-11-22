import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MSG_POLICY_UNAVAILABLE,
  MSG_TOOL_NOT_IN_PACK,
  PolicyCache,
  allowedTools,
  loadPacks,
  packBlockReason,
  packPolicyFrom,
  parsePacks,
} from "../src/packs.js";
import { DELETE_TOOL } from "../src/plugin.js";

const defs = parsePacks({
  schema: 1,
  packs: {
    core: { name: "Core", tools: ["read", "exec", "offmanual_delete_files"] },
    "tally-read": { name: "Tally", tools: ["tally_read"] },
    "tally-post": { name: "Tally post", tools: ["tally_post_voucher"] },
  },
});

describe("packs", () => {
  it("parses and rejects bad pack files", () => {
    expect(() => parsePacks(null)).toThrow();
    expect(() => parsePacks({ schema: 2, packs: {} })).toThrow();
    expect(() => parsePacks({ schema: 1, packs: { other: { name: "x", tools: [] } } })).toThrow("core");
    expect(() => parsePacks({ schema: 1, packs: { core: { name: "x", tools: ["Bad Tool"] } } })).toThrow();
    expect(() => parsePacks({ schema: 1, packs: { "Core!": { name: "x", tools: [] } } })).toThrow();
  });

  it("the shipped skills/packs.json is valid and core has the review tool", () => {
    const shipped = loadPacks(fileURLToPath(new URL("../../../../skills/packs.json", import.meta.url)));
    expect(shipped.packs.core?.tools).toContain(DELETE_TOOL);
    expect(shipped.packs.core?.tools).toContain("read");
    // Tools the gateway config denies must never be granted by a pack.
    for (const p of Object.values(shipped.packs)) {
      for (const denied of [
        "gateway",
        "plugins",
        "browser",
        "nodes",
        "computer",
        "cron",
        "message",
        "sessions_send",
      ]) {
        expect(p.tools).not.toContain(denied);
      }
    }
  });

  it("union of granted packs; unknown packs grant nothing", () => {
    const a = allowedTools(defs, { packs: ["core", "tally-read", "ghost"] }, "desk");
    expect([...a].sort()).toEqual(["exec", "offmanual_delete_files", "read", "tally_read"]);
  });

  it("Telegram keeps core plus firm-allowed packs only", () => {
    const p = { packs: ["core", "tally-read", "tally-post"], telegramAllowedPacks: ["tally-read"] };
    expect(allowedTools(defs, p, "telegram").has("tally_read")).toBe(true);
    expect(allowedTools(defs, p, "telegram").has("tally_post_voucher")).toBe(false);
    expect(allowedTools(defs, p, "desk").has("tally_post_voucher")).toBe(true);
    expect(allowedTools(defs, { packs: ["core"], telegramAllowedPacks: [] }, "telegram").has("read")).toBe(
      true,
    );
    // A pack the employee doesn't have isn't granted by the Telegram list.
    expect(
      allowedTools(defs, { packs: ["core"], telegramAllowedPacks: ["tally-read"] }, "telegram").has(
        "tally_read",
      ),
    ).toBe(false);
  });

  it("blocks tools outside the packs and fails closed without policy", () => {
    const a = allowedTools(defs, { packs: ["core"] }, "desk");
    expect(packBlockReason("read", a)).toBeUndefined();
    expect(packBlockReason("READ", a)).toBeUndefined();
    expect(packBlockReason("bash", a)).toBeUndefined(); // alias of exec
    expect(packBlockReason("message", a)).toBe(MSG_TOOL_NOT_IN_PACK);
    expect(packBlockReason("read", null)).toBe(MSG_POLICY_UNAVAILABLE);
  });

  it("policy replies are validated and cached", () => {
    expect(packPolicyFrom({ packs: ["core"], telegramAllowedPacks: ["tally-read", 3] })).toEqual({
      packs: ["core"],
      telegramAllowedPacks: ["tally-read"],
    });
    expect(packPolicyFrom({ packs: "core" })).toBeNull();
    expect(packPolicyFrom(null)).toBeNull();
    const c = new PolicyCache(1000);
    expect(c.get(0)).toBeNull();
    c.set({ packs: ["core"] }, 0);
    expect(c.get(1000)).toEqual({ packs: ["core"] });
    expect(c.get(1001)).toBeNull();
  });
});
