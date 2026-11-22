import { describe, expect, it } from "vitest";
import { askPrompt, latestAsk } from "./inbox";

const A = String.raw`C:\a`;
const B = String.raw`C:\b`;
const MEHTA = String.raw`C:\Clients\Mehta`;

describe("inbox", () => {
  it("uses the newest ask in a batch and ignores show requests", () => {
    expect(latestAsk([])).toBeNull();
    expect(latestAsk([{ kind: "show" }])).toBeNull();
    expect(
      latestAsk([{ kind: "ask", path: A }, { kind: "show" }, { kind: "ask", path: B }, { kind: "show" }]),
    ).toBe(B);
    expect(latestAsk([{ kind: "ask", path: "" }])).toBeNull();
  });
  it("puts the path in front of the question", () => {
    expect(askPrompt(MEHTA)).toBe(`About ${MEHTA}: `);
  });
});
