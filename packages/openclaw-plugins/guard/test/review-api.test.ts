import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleDecide, STEP_UP_ACTION, stepUpActionsFrom, type DecideDeps } from "../src/review-api.js";
import { ReviewQueue, ReviewStore, type ActionKind } from "../src/review.js";

const GRANT = "0123456789abcdef0123456789abcdef";

async function setup() {
  const runs: string[] = [];
  const kind: ActionKind = {
    kind: "count",
    parse: (p) => ({ ok: true, value: p }),
    summarize: () => "Count.",
    execute: async () => {
      runs.push("x");
      return { ok: true, message: "Done." };
    },
  };
  const q = new ReviewQueue(new ReviewStore(join(await mkdtemp(join(tmpdir(), "om-ra-")), "r.json")), [kind]);
  await q.propose("count", { n: 1 });
  return { q, runs };
}

const deps = (actions: string[] | null, valid: string[] = []): DecideDeps & { checked: string[] } => {
  const checked: string[] = [];
  return {
    checked,
    stepUpActions: async () => actions,
    grantValid: async (g, a) => {
      checked.push(`${g}:${a}`);
      return valid.includes(g);
    },
  };
};

describe("handleDecide", () => {
  it("approves without step-up when the firm doesn't ask for it", async () => {
    const { q, runs } = await setup();
    const r = await handleDecide(q, { ids: ["1"], decision: "approve" }, deps([]));
    expect(r).toMatchObject({ ok: true, payload: { results: [{ id: "1", status: "done" }] } });
    expect(runs).toHaveLength(1);
  });

  it("asks for step-up, then approves with a live grant", async () => {
    const { q, runs } = await setup();
    const d = deps([STEP_UP_ACTION], [GRANT]);
    expect(await handleDecide(q, { ids: ["1"], decision: "approve" }, d)).toEqual({
      ok: true,
      payload: { stepUpRequired: true, action: STEP_UP_ACTION },
    });
    expect(
      await handleDecide(q, { ids: ["1"], decision: "approve", stepUpGrant: "f".repeat(32) }, d),
    ).toMatchObject({
      payload: { stepUpRequired: true },
    });
    expect(runs).toHaveLength(0);
    const ok = await handleDecide(q, { ids: ["1"], decision: "approve", stepUpGrant: GRANT }, d);
    expect(ok).toMatchObject({ ok: true, payload: { results: [{ status: "done" }] } });
    expect(d.checked).toContain(`${GRANT}:${STEP_UP_ACTION}`);
    expect(runs).toHaveLength(1);
  });

  it("reject never needs step-up; unreadable policy blocks approval", async () => {
    const { q, runs } = await setup();
    expect(await handleDecide(q, { ids: ["1"], decision: "approve" }, deps(null))).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    });
    expect(await handleDecide(q, { ids: ["1"], decision: "reject" }, deps(null))).toMatchObject({
      ok: true,
      payload: { results: [{ status: "rejected" }] },
    });
    expect(runs).toHaveLength(0);
  });

  it("refuses malformed requests", async () => {
    const { q } = await setup();
    for (const p of [
      { ids: [], decision: "approve" },
      { ids: ["x"], decision: "approve" },
      { ids: ["1"], decision: "maybe" },
      { ids: ["1", "2"], decision: "approve", params: {} },
      { ids: ["1"], decision: "approve", stepUpGrant: "not-hex" },
      { ids: ["1"], decision: "approve", sid: "S-1-5-21-1" },
    ]) {
      expect(await handleDecide(q, p, deps([])), JSON.stringify(p)).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    }
  });

  it("reads stepUpActions from policy.get", () => {
    expect(stepUpActionsFrom({ stepUpActions: ["review.approve"] })).toEqual(["review.approve"]);
    expect(stepUpActionsFrom({})).toEqual([]);
    expect(stepUpActionsFrom({ stepUpActions: "review.approve" })).toBeNull();
  });
});
