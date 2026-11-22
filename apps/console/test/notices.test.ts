import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { firms, invoices, notices } from "@/db/schema";
import type { SessionState } from "@/lib/auth";
import type { DB } from "@/lib/db";
import { uuidv7 } from "@/lib/ids";
import { activeNotices, billingNotices, postNotice } from "@/lib/notices";
import { testDb } from "./helpers/db";

let db: DB;
let close: () => Promise<void>;
let now = new Date("2026-12-01T05:00:00Z");
const deps = () => ({ db, now: () => now });
let firmA: string;
let firmB: string;

const staff: SessionState = {
  principal: { kind: "console", userId: uuidv7(), email: "d@om.in", name: "D", role: "staff" },
  mfa: true,
  token: "t",
};
const adminOf = (firmId: string): SessionState => ({
  principal: { kind: "firm_admin", userId: uuidv7(), email: "o@f.in", name: "O", role: "owner", firmId },
  mfa: true,
  token: "t",
});

async function seedFirm(name: string) {
  const id = uuidv7();
  await db.insert(firms).values({ id, name, legalName: name, stateCode: "27", billingEmail: "a@b.in" });
  return id;
}

beforeEach(async () => {
  ({ db, close } = await testDb());
  now = new Date("2026-12-01T05:00:00Z");
  firmA = await seedFirm("Mehta");
  firmB = await seedFirm("Shah");
});
afterEach(async () => close());

describe("posting notices", () => {
  it("staff post to one firm or all; a firm admin only to their own firm", async () => {
    await postNotice(deps(), staff, {
      firmId: null,
      title: "Maintenance tonight",
      body: "Desk restarts at 22:00 IST.",
    });
    await postNotice(deps(), adminOf(firmA), {
      firmId: firmA,
      audience: "all",
      title: "Office closed",
      body: "Closed on 25-12-2026.",
    });
    await expect(
      postNotice(deps(), adminOf(firmA), { firmId: firmB, title: "Hi there", body: "x" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      postNotice(deps(), adminOf(firmA), { firmId: null, title: "Hi there", body: "x" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(postNotice(deps(), staff, { firmId: firmA, title: "x", body: "y" })).rejects.toThrow(
      /right format/,
    );
    const a = await activeNotices(db, firmA, now);
    expect(a.map((n) => [n.title, n.kind])).toEqual([
      ["Maintenance tonight", "update"],
      ["Office closed", "admin"],
    ]);
    expect((await activeNotices(db, firmB, now)).map((n) => n.title)).toEqual(["Maintenance tonight"]);
  });

  it("ended notices disappear", async () => {
    await postNotice(deps(), staff, {
      firmId: firmA,
      title: "Short one",
      body: "x",
      endsAt: "2026-12-01T06:00:00Z",
    });
    expect(await activeNotices(db, firmA, now)).toHaveLength(1);
    expect(await activeNotices(db, firmA, new Date("2026-12-01T06:00:01Z"))).toHaveLength(0);
  });
});

describe("billing notices", () => {
  async function invoice(dueOn: string, status: "issued" | "paid" = "issued") {
    const id = uuidv7();
    await db.insert(invoices).values({
      id,
      firmId: firmA,
      number: "OM/FY2026-27/0001",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      issuedOn: "2026-12-01",
      dueOn,
      taxablePaise: 200000n,
      cgstPaise: 18000n,
      sgstPaise: 18000n,
      igstPaise: 0n,
      totalPaise: 236000n,
      status,
    });
    return id;
  }

  it("issued, due soon, due today and overdue are each created once, for admins", async () => {
    const inv = await invoice("2026-12-16");
    expect(await billingNotices(deps())).toBe(1); // issued
    expect(await billingNotices(deps())).toBe(0);
    let titles = (await activeNotices(db, firmA, now)).map((n) => n.title);
    expect(titles).toEqual(["Invoice OM/FY2026-27/0001 issued"]);
    now = new Date("2026-12-10T05:00:00Z");
    expect(await billingNotices(deps())).toBe(1); // due in 6 days
    now = new Date("2026-12-16T05:00:00Z");
    expect(await billingNotices(deps())).toBe(1); // due today
    now = new Date("2026-12-20T05:00:00Z");
    expect(await billingNotices(deps())).toBe(1); // overdue
    titles = (await activeNotices(db, firmA, now)).map((n) => n.title);
    expect(titles).toContain("Invoice OM/FY2026-27/0001 is overdue");
    const all = await db.select().from(notices);
    expect(all.every((n) => n.audience === "admins" && n.kind === "billing")).toBe(true);
    expect(all.find((n) => n.dedupeKey?.endsWith("overdue"))!.body).toContain(
      "₹2,360.00 was due on 16-12-2026",
    );

    await db.update(invoices).set({ status: "paid" }).where(eq(invoices.id, inv));
    await billingNotices(deps());
    expect(await activeNotices(db, firmA, new Date(now.getTime() + 1000))).toHaveLength(0);
  });
});
