import { describe, expect, it } from "vitest";
import { flushUsage, UsageMeter, type UsageCounts } from "../src/usage.js";

describe("UsageMeter", () => {
  it("counts turns and tokens, ignoring junk", () => {
    const m = new UsageMeter();
    m.addTurn();
    m.addTurn();
    m.addUsage({ input: 1200, output: 300, cacheRead: 999, total: 2499 });
    m.addUsage({ input: -5, output: "7" });
    m.addUsage(undefined);
    m.addUsage({ input: 10.7, output: Number.NaN });
    expect(m.take()).toEqual({ turns: 2, inputTokens: 1210, outputTokens: 300 });
    expect(m.take()).toBeNull();
  });

  it("a failed send keeps the counts for the next flush", async () => {
    const m = new UsageMeter();
    m.addTurn();
    m.addUsage({ input: 100, output: 10 });
    const sent: UsageCounts[] = [];
    expect(await flushUsage(m, async () => Promise.reject(new Error("agent restarting")))).toBe(false);
    m.addTurn();
    expect(await flushUsage(m, async (c) => sent.push(c))).toBe(true);
    expect(sent).toEqual([{ turns: 2, inputTokens: 100, outputTokens: 10 }]);
    expect(await flushUsage(m, async (c) => sent.push(c))).toBe(true); // nothing pending
    expect(sent).toHaveLength(1);
  });
});
