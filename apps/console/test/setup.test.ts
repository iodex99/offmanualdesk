import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { employees, firms, servers } from "@/db/schema";
import type { AdminDeps } from "@/lib/admin";
import type { SessionState } from "@/lib/auth";
import type { DB } from "@/lib/db";
import { uuidv7 } from "@/lib/ids";
import { firmServers, importEmployees, MAX_IMPORT_ROWS } from "@/lib/setup";
import { testDb } from "./helpers/db";

let db: DB;
let close: () => Promise<void>;
let deps: AdminDeps;
let firmId: string;
let otherFirm: string;
const NOW = new Date("2026-11-23T05:00:00Z");

const adminOf = (id: string): SessionState => ({
  principal: { kind: "firm_admin", userId: "fa", email: "o@f.in", name: "O", role: "owner", firmId: id },
  mfa: true,
  token: "t",
});

beforeEach(async () => {
  ({ db, close } = await testDb());
  deps = { db, now: () => NOW };
  firmId = uuidv7();
  otherFirm = uuidv7();
  await db.insert(firms).values([
    { id: firmId, name: "Mehta", legalName: "Mehta", stateCode: "27", billingEmail: "a@b.in" },
    { id: otherFirm, name: "Shah", legalName: "Shah", stateCode: "27", billingEmail: "a@b.in" },
  ]);
});
afterEach(async () => close());

describe("firm servers", () => {
  it("lists only pre-flight problems, firm-scoped", async () => {
    await db.insert(servers).values({
      id: uuidv7(),
      firmId,
      hostname: "RDS01",
      publicKey: "k1",
      enrolledAt: NOW,
      health: "amber",
      preflightJson: {
        overall: "warn",
        at: "2026-11-23T05:00:00Z",
        results: [
          { id: "memory", title: "Memory", status: "pass", detail: "64 GB" },
          {
            id: "webview2",
            title: "WebView2",
            status: "fail",
            detail: "Not installed",
            fix: "Install the WebView2 runtime.",
          },
          { id: "tally", title: "TallyPrime", status: "warn", detail: "Not found" },
        ],
      },
    });
    const list = await firmServers(deps, adminOf(firmId), firmId);
    expect(list).toHaveLength(1);
    expect(list[0]!.problems.map((p) => p.id)).toEqual(["webview2", "tally"]);
    expect(list[0]!.preflightOverall).toBe("warn");
    await expect(firmServers(deps, adminOf(otherFirm), firmId)).rejects.toMatchObject({ status: 403 });
  });
});

describe("bulk import", () => {
  it("adds valid lines, skips bad ones with reasons, ignores header and blanks", async () => {
    const text = [
      "Name, Email",
      "Asha Mehta, asha@mehtaco.in",
      "",
      "Ravi Shah;ravi@mehtaco.in",
      "No email here",
      "Bad Email, not-an-email",
      "Asha Again, ASHA@mehtaco.in",
    ].join("\n");
    const r = await importEmployees(deps, adminOf(firmId), firmId, { text });
    expect(r.added.map((a) => a.name)).toEqual(["Asha Mehta", "Ravi Shah"]);
    expect(r.skipped.map((s) => s.line)).toEqual([5, 6, 7]);
    expect(r.skipped[0]!.reason).toMatch(/Name, email/);
    expect(r.skipped[2]!.reason).toMatch(/already in this firm/);
    const rows = await db.select().from(employees);
    expect(rows.map((e) => e.email).sort()).toEqual(["asha@mehtaco.in", "ravi@mehtaco.in"]);
  });

  it("refuses other firms, empty lists and too many rows", async () => {
    await expect(
      importEmployees(deps, adminOf(otherFirm), firmId, { text: "A, a@b.in" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(importEmployees(deps, adminOf(firmId), firmId, { text: "\n\n" })).rejects.toThrow(/empty/);
    await expect(importEmployees(deps, adminOf(firmId), firmId, { text: 5 })).rejects.toThrow(/as text/);
    const many = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `P${i}, p${i}@x.in`).join("\n");
    await expect(importEmployees(deps, adminOf(firmId), firmId, { text: many })).rejects.toThrow(/At most/);
  });
});
