import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deleteFiles } from "../src/delete-files.js";
import {
  REVIEW_BLOCK_DELETE,
  ReviewQueue,
  ReviewStore,
  bypassBlockReason,
  queuedText,
  type ActionKind,
} from "../src/review.js";

const tmp = () => mkdtemp(join(tmpdir(), "om-review-"));

/** A counting action so tests can prove an approval runs exactly once. */
function counter() {
  const runs: string[] = [];
  const kind: ActionKind<{ n: string }> = {
    kind: "count",
    parse: (p) =>
      p && typeof p === "object" && typeof (p as { n?: unknown }).n === "string"
        ? { ok: true, value: { n: (p as { n: string }).n } }
        : { ok: false, message: "n required" },
    summarize: (p) => `Count ${p.n}.`,
    execute: async (p) => {
      runs.push(p.n);
      if (p.n === "boom") throw new Error("internal detail");
      return { ok: p.n !== "bad", message: `Counted ${p.n}.` };
    },
  };
  return { kind: kind as unknown as ActionKind, runs };
}

describe("ReviewStore", () => {
  it("persists proposals and ids across instances", async () => {
    const f = join(await tmp(), "sub", "review.json");
    const a = new ReviewStore(f);
    expect((await a.add("count", { n: "1" }, "Count 1.")).id).toBe("1");
    expect((await a.add("count", { n: "2" }, "Count 2.")).id).toBe("2");
    const b = new ReviewStore(f);
    expect((await b.list()).map((p) => p.status)).toEqual(["pending", "pending"]);
    expect((await b.add("count", { n: "3" }, "Count 3.")).id).toBe("3");
  });

  it("never re-runs an approval that was executing when the gateway stopped", async () => {
    const f = join(await tmp(), "review.json");
    const a = new ReviewStore(f);
    await a.add("count", { n: "1" }, "Count 1.");
    await a.claim("1", "approved");
    const [p] = await new ReviewStore(f).list();
    expect(p?.status).toBe("failed");
    expect(p?.result).toMatch(/Check whether it happened/);
    expect(JSON.parse(await readFile(f, "utf8")).items[0].status).toBe("failed");
  });

  it("refuses to start on a corrupt queue instead of silently emptying it", async () => {
    const f = join(await tmp(), "review.json");
    await writeFile(f, "{not json", "utf8");
    await expect(new ReviewStore(f).list()).rejects.toThrow();
  });

  it("keeps only the newest finished items", async () => {
    const f = join(await tmp(), "review.json");
    const s = new ReviewStore(f, () => new Date(), 3);
    for (let i = 0; i < 8; i++) {
      const p = await s.add("count", { n: String(i) }, "x");
      await s.claim(p.id, "rejected");
    }
    await s.add("count", { n: "pending" }, "x");
    const items = await s.list();
    expect(items.filter((p) => p.status === "rejected")).toHaveLength(3);
    expect(items.some((p) => p.status === "pending")).toBe(true);
    expect(items[0]?.id).toBe("6");
  });

  it("serialises concurrent adds", async () => {
    const s = new ReviewStore(join(await tmp(), "review.json"));
    const ids = await Promise.all(
      Array.from({ length: 20 }, (_, i) => s.add("count", { n: String(i) }, "x")),
    );
    expect(new Set(ids.map((p) => p.id)).size).toBe(20);
  });
});

describe("ReviewQueue", () => {
  async function setup() {
    const c = counter();
    const events: string[] = [];
    const q = new ReviewQueue(
      new ReviewStore(join(await tmp(), "review.json")),
      [c.kind],
      (cat, action, result) => events.push(`${cat}:${action}:${result}`),
    );
    return { q, c, events };
  }

  it("propose validates params and never executes", async () => {
    const { q, c, events } = await setup();
    await expect(q.propose("count", {})).rejects.toThrow("n required");
    await expect(q.propose("nope", {})).rejects.toThrow("Unknown action");
    const p = await q.propose("count", { n: "1" }, "agent:main:main");
    expect(p).toMatchObject({ status: "pending", summary: "Count 1.", sessionKey: "agent:main:main" });
    expect(queuedText(p)).toMatch(/^Queued for review #1: Count 1\. Nothing has been done yet/);
    expect(c.runs).toEqual([]);
    expect(events).toEqual(["review_queued:count:ok"]);
  });

  it("approve executes exactly once; a second approval is stale", async () => {
    const { q, c } = await setup();
    await q.propose("count", { n: "1" });
    const [first, second] = await Promise.all([q.decide(["1"], "approve"), q.decide(["1"], "approve")]);
    expect(c.runs).toEqual(["1"]);
    const statuses = [first[0]?.status, second[0]?.status].sort();
    expect(statuses).toEqual(["done", "not_found"]);
    expect((await q.store.list())[0]).toMatchObject({ status: "done", result: "Counted 1." });
  });

  it("reject does nothing and can't be approved afterwards", async () => {
    const { q, c, events } = await setup();
    await q.propose("count", { n: "1" });
    expect((await q.decide(["1"], "reject"))[0]?.status).toBe("rejected");
    expect((await q.decide(["1"], "approve"))[0]?.status).toBe("not_found");
    expect(c.runs).toEqual([]);
    expect(events).toContain("review_rejected:count:ok");
  });

  it("an edit is validated and replaces params and summary", async () => {
    const { q, c } = await setup();
    await q.propose("count", { n: "1" });
    expect((await q.decide(["1"], "approve", { n: 5 }))[0]).toMatchObject({
      status: "pending",
      message: "n required",
    });
    expect(c.runs).toEqual([]);
    expect((await q.decide(["1"], "approve", { n: "2" }))[0]?.status).toBe("done");
    expect(c.runs).toEqual(["2"]);
    expect((await q.store.list())[0]).toMatchObject({ summary: "Count 2.", params: { n: "2" } });
  });

  it("approve all reports each item; failures and thrown errors are plain", async () => {
    const { q, c, events } = await setup();
    await q.propose("count", { n: "ok" });
    await q.propose("count", { n: "bad" });
    await q.propose("count", { n: "boom" });
    const r = await q.decide(["1", "2", "3", "99"], "approve");
    expect(r.map((x) => x.status)).toEqual(["done", "failed", "failed", "not_found"]);
    expect(r[2]?.message).not.toMatch(/internal detail/);
    expect(c.runs).toEqual(["ok", "bad", "boom"]);
    expect(events.filter((e) => e.startsWith("review_approved"))).toEqual([
      "review_approved:count:done",
      "review_approved:count:failed",
      "review_approved:count:failed",
    ]);
  });
});

describe("delete_files action", () => {
  it("accepts full Windows and UNC paths only", () => {
    const ok = deleteFiles.parse({
      paths: ["C:\\Clients\\A\\x.pdf", "\\\\fs01\\Clients\\B\\y.xlsx", "c:\\clients\\a\\X.PDF"],
      reason: "duplicates",
    });
    expect(ok).toEqual({
      ok: true,
      value: { paths: ["C:\\Clients\\A\\x.pdf", "\\\\fs01\\Clients\\B\\y.xlsx"], reason: "duplicates" },
    });
    for (const bad of [
      "x.pdf",
      "C:/a/b.pdf",
      "C:\\a\\*.pdf",
      "C:\\a\\..\\b.pdf",
      "\\\\fs01",
      "C:\\a\\b?.pdf",
      "C:\\a\nb",
    ]) {
      expect(deleteFiles.parse({ paths: [bad], reason: "r" }).ok, bad).toBe(false);
    }
    expect(deleteFiles.parse({ paths: ["C:\\a.pdf"] }).ok).toBe(false);
    expect(deleteFiles.parse({ paths: [], reason: "r" }).ok).toBe(false);
    expect(deleteFiles.parse({ paths: ["C:\\a.pdf"], reason: "r", force: true }).ok).toBe(false);
    expect(
      deleteFiles.parse({ paths: Array.from({ length: 51 }, (_, i) => `C:\\a${i}.pdf`), reason: "r" }).ok,
    ).toBe(false);
  });

  it("summarises with file names, not full paths", () => {
    const p = {
      paths: ["C:\\A\\one.pdf", "C:\\A\\two.pdf", "C:\\A\\three.pdf", "C:\\A\\four.pdf"],
      reason: "old drafts",
    };
    expect(deleteFiles.summarize(p)).toBe(
      "Delete 4 files (one.pdf, two.pdf, three.pdf and 1 more). Reason: old drafts",
    );
  });

  it("deletes files, skips folders, counts missing ones", async () => {
    const dir = await tmp();
    const a = join(dir, "a.txt");
    const sub = join(dir, "folder");
    await writeFile(a, "x");
    await mkdir(sub);
    const r = await deleteFiles.execute({ paths: [a, join(dir, "gone.txt"), sub], reason: "r" });
    expect(existsSync(a)).toBe(false);
    expect(existsSync(sub)).toBe(true);
    expect(r).toEqual({
      ok: false,
      message: "Deleted 1 of 3. 1 were already gone. 1 are folders, which Off Manual doesn't delete.",
    });
  });
});

describe("bypassBlockReason", () => {
  it("blocks delete commands and delete tools", () => {
    for (const command of [
      "Remove-Item C:\\Clients\\x.pdf",
      "rm -rf C:\\x",
      "del /q C:\\x.pdf",
      "cd C:\\x; ri a.txt",
      "Get-ChildItem | Remove-Item",
      "cmd /c rd /s /q C:\\x",
      "erase C:\\x",
      "[System.IO.File]::Delete('C:\\x')",
      "python -c \"import shutil; shutil.rmtree('x')\"",
      "node -e \"require('fs').unlinkSync('x')\"",
      "Clear-RecycleBin -Force",
      "powershell -Command Remove-Item C:\\x",
      'pwsh -c "del C:\\x"',
    ]) {
      expect(bypassBlockReason("exec", { command }), command).toBe(REVIEW_BLOCK_DELETE);
    }
    expect(bypassBlockReason("fs_delete", {})).toBe(REVIEW_BLOCK_DELETE);
    expect(
      bypassBlockReason("apply_patch", { input: "*** Begin Patch\n*** Delete File: a.txt\n*** End Patch" }),
    ).toBe(REVIEW_BLOCK_DELETE);
  });

  it("lets ordinary commands and tools through", () => {
    for (const command of [
      "Get-ChildItem C:\\Clients",
      "Get-Content C:\\a\\delivery.txt",
      "Select-String -Pattern 'rm' C:\\a.txt",
      "echo model",
      "Remove-ItemProperty -Path HKCU:\\x -Name y",
      "dir C:\\x",
    ]) {
      expect(bypassBlockReason("exec", { command }), command).toBeUndefined();
    }
    expect(bypassBlockReason("read", { path: "C:\\rm" })).toBeUndefined();
    expect(bypassBlockReason("apply_patch", { input: "*** Update File: a.txt" })).toBeUndefined();
    expect(bypassBlockReason("exec", null)).toBeUndefined();
  });
});
