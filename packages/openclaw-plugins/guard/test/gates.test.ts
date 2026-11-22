import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBridge, AgentUnavailable } from "../src/agent-bridge.js";
import {
  ACCESS_DENIED_TEXT,
  LockCache,
  MSG_PAUSED,
  StoppedRuns,
  deniedInResult,
  deniedResult,
  lockGate,
  targetFromArgs,
} from "../src/gates.js";
import { channelOf } from "../src/plugin.js";

const now = new Date("2026-11-22T10:00:00Z");
const later = (min: number) => new Date(now.getTime() + min * 60e3).toISOString();

describe("lockGate (fail closed)", () => {
  it("blocks when the Server Agent can't be asked", () => {
    expect(lockGate(null, "desk", now)).toMatchObject({ outcome: "block", reason: "agent_unavailable" });
  });
  it("passes when unlocked; blocks when locked with a next step", () => {
    expect(lockGate({ locked: false }, "desk", now)).toEqual({ outcome: "pass" });
    const d = lockGate({ locked: true }, "desk", now);
    expect(d).toMatchObject({ outcome: "block", reason: "locked" });
    expect(d.outcome === "block" && d.message).toContain("PIN");
  });
  it("lockout wins over everything", () => {
    expect(lockGate({ locked: false, lockedUntil: later(5) }, "desk", now)).toMatchObject({
      reason: "lockout",
    });
  });
  it("Telegram may run inside its unlock window only", () => {
    expect(lockGate({ locked: true, telegramUnlockedUntil: later(30) }, "telegram", now)).toEqual({
      outcome: "pass",
    });
    expect(lockGate({ locked: true, telegramUnlockedUntil: later(-1) }, "telegram", now)).toMatchObject({
      outcome: "block",
    });
    expect(lockGate({ locked: true, telegramUnlockedUntil: later(30) }, "desk", now)).toMatchObject({
      outcome: "block",
    });
  });
  it("channelOf recognises Telegram session keys", () => {
    expect(channelOf("agent:main:telegram:123", undefined)).toBe("telegram");
    expect(channelOf("agent:main:main", "telegram")).toBe("telegram");
    expect(channelOf("agent:main:main", undefined)).toBe("desk");
  });
});

describe("LockCache", () => {
  it("expires after 5 s", () => {
    const c = new LockCache(5000);
    c.set({ locked: false }, 1000);
    expect(c.get(5999)).toEqual({ locked: false });
    expect(c.get(6001)).toBeNull();
  });
});

describe("access denied (ADR-022)", () => {
  const winDenied = {
    content: [
      { type: "text", text: "Error: EPERM: operation not permitted, open '\\\\fs\\Clients\\X\\a.xlsx'" },
    ],
  };
  it("detects denials only in error results", () => {
    expect(deniedInResult(true, winDenied)).toEqual({ kind: "access_denied", code: "EPERM" });
    expect(deniedInResult(false, winDenied)).toBeNull();
    expect(deniedInResult(true, { content: [{ type: "image" }] })).toBeNull();
    expect(deniedInResult(true, { content: [{ type: "text", text: "ENOENT: no such file" }] })).toBeNull();
  });
  it("replacement tells the model to stop and not work around it", () => {
    const r = deniedResult({ kind: "access_denied", code: "EPERM" });
    expect(r.content[0].text).toBe(ACCESS_DENIED_TEXT);
    expect(ACCESS_DENIED_TEXT).toMatch(/do not retry/i);
    expect(ACCESS_DENIED_TEXT).toMatch(/do not copy/i);
    expect(r.details).toEqual({ offmanual: "access_denied", code: "EPERM" });
  });
  it("StoppedRuns blocks the rest of the run, then forgets it", () => {
    const s = new StoppedRuns(1000);
    s.stop("run-1", 0);
    expect(s.isStopped("run-1")).toBe(true);
    expect(s.isStopped("run-2")).toBe(false);
    expect(s.isStopped(undefined)).toBe(false);
    s.end("run-1");
    expect(s.isStopped("run-1")).toBe(false);
    s.stop("old", 0);
    s.stop("new", 5000); // sweeps entries older than ttl
    expect(s.isStopped("old")).toBe(false);
  });
  it("targetFromArgs picks the path argument", () => {
    expect(targetFromArgs({ path: "\\\\fs\\Clients\\Mehta" })).toBe("\\\\fs\\Clients\\Mehta");
    expect(targetFromArgs({ command: "dir" })).toBe("");
    expect(targetFromArgs(null)).toBe("");
    expect(targetFromArgs({ path: "x".repeat(5000) })).toHaveLength(1024);
  });
});

describe("AgentBridge (against a fake bridge process)", () => {
  const fake = fileURLToPath(new URL("./fixtures/fake-bridge.mjs", import.meta.url));
  let bridge: AgentBridge;
  afterEach(() => bridge?.close());

  it("round-trips calls and ignores junk lines", async () => {
    bridge = new AgentBridge(process.execPath, [fake], 3000);
    expect(await bridge.call("lock.get")).toEqual({ locked: false, dayUnlocked: true });
    expect(await bridge.call("audit.append", { category: "access_denied" })).toEqual({ ok: true });
    await expect(bridge.call("audit.append", { category: "x" })).rejects.toMatchObject({ code: -32602 });
  });
  it("rejects methods the guard may not use", async () => {
    bridge = new AgentBridge(process.execPath, [fake], 3000);
    await expect(bridge.call("gateway.lease" as never)).rejects.toThrow(/not allowed/);
  });
  it("fails closed when the bridge dies or can't start", { timeout: 20_000 }, async () => {
    bridge = new AgentBridge(process.execPath, [fake], 3000);
    await expect(bridge.call("policy.get")).rejects.toBeInstanceOf(AgentUnavailable);
    // It restarts on the next call.
    expect(await bridge.call("lock.get")).toMatchObject({ locked: false });
    const missing = new AgentBridge("Z:\\no\\such\\server-agent.exe", ["bridge"], 1000);
    await expect(missing.call("lock.get")).rejects.toBeInstanceOf(AgentUnavailable);
    missing.close();
  });
});

describe("licence gate", () => {
  const now = new Date("2026-11-23T05:00:00Z");
  it("blocks every channel while the service is paused, even when unlocked", () => {
    for (const channel of ["desk", "telegram"] as const) {
      expect(
        lockGate(
          {
            locked: false,
            servicePaused: true,
            pausedMessage: "Off Manual isn't activated on this server yet.",
          },
          channel,
          now,
        ),
      ).toEqual({
        outcome: "block",
        reason: "licence",
        message: "Off Manual isn't activated on this server yet.",
      });
    }
    expect(
      lockGate(
        { locked: false, servicePaused: true, telegramUnlockedUntil: "2026-11-23T06:00:00Z" },
        "telegram",
        now,
      ),
    ).toEqual({ outcome: "block", reason: "licence", message: MSG_PAUSED });
  });
  it("passes when not paused", () => {
    expect(lockGate({ locked: false, servicePaused: false }, "desk", now)).toEqual({ outcome: "pass" });
  });
});
