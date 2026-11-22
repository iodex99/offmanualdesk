// Checks the plugin packaging against docs/OPENCLAW_NOTES.md §4 so a typo can't
// silently stop OpenClaw from loading the guard.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLUGIN_ID } from "../src/index.js";

const read = (p: string) =>
  JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")) as Record<string, unknown>;

describe("guard plugin packaging", () => {
  const manifest = read("../openclaw.plugin.json");
  const pkg = read("../package.json");

  it("manifest has the required id and inline configSchema", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.configSchema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("starts on gateway startup (onStartup is no longer implicit)", () => {
    expect(manifest.activation).toEqual({ onStartup: true });
  });

  it("declares the tool-result middleware contract needed for access-denied handling (ADR-022)", () => {
    expect(manifest.contracts).toEqual({ agentToolResultMiddleware: ["openclaw"] });
  });

  it("package.json points OpenClaw at the built entry and pins the host version", () => {
    expect(pkg.type).toBe("module");
    const oc = pkg.openclaw as { extensions: string[]; install: { minHostVersion: string } };
    expect(oc.extensions).toEqual(["./dist/plugin.js"]);
    expect(oc.install.minHostVersion).toBe(">=2026.11.6");
    const dev = pkg.devDependencies as Record<string, string>;
    expect(dev.openclaw).toBe("2026.11.6");
  });

  it("has no runtime dependencies (the built entry must load standalone)", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
