import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { employees, firmAdmins, firms, invoices, servers, usageDaily } from "@/db/schema";
import { digestText, emailBillingNotices, lastWeek, weeklyDigests } from "@/lib/admin-mail";
import type { DB } from "@/lib/db";
import type { Email, Mailer } from "@/lib/email";
import { uuidv7 } from "@/lib/ids";
import { billingNotices } from "@/lib/notices";
import { testDb } from "./helpers/db";

let db: DB;
let close: () => Promise<void>;
let now = new Date("2026-12-01T05:00:00Z"); // Tuesday 01-12-2026, 10:30 IST
let sent: Email[] = [];
let failFor = "";
const mailer: Mailer = {
  async send(m) {
    if (m.to === failFor) throw new Error("bounced");
    sent.push(m);
  },
};
const deps = () => ({ db, now: () => now, mailer });
let firmId: string;

beforeEach(async () => {
  ({ db, close } = await testDb());
  now = new Date("2026-12-01T05:00:00Z");
  sent = [];
  failFor = "";
  firmId = uuidv7();
  await db.insert(firms).values({
    id: firmId,
    name: "Mehta",
    legalName: "Mehta LLP",
    stateCode: "27",
    billingEmail: "a@b.in",
    status: "active",
  });
  await db.insert(firmAdmins).values([
    { id: uuidv7(), firmId, email: "owner@mehta.in", name: "Owner", role: "owner" },
    { id: uuidv7(), firmId, email: "partner@mehta.in", name: "Partner", role: "admin" },
    {
      id: uuidv7(),
      firmId,
      email: "gone@mehta.in",
      name: "Gone",
      role: "admin",
      disabledAt: new Date("2026-01-01"),
    },
  ]);
});
afterEach(async () => close());

async function issued(dueOn: string) {
  await db.insert(invoices).values({
    id: uuidv7(),
    firmId,
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
    status: "issued",
  });
}

describe("billing notice emails", () => {
  it("emails each new billing notice to the firm's active admins, once", async () => {
    await issued("2026-12-16");
    const since = now;
    await billingNotices(deps());
    expect(await emailBillingNotices(deps(), since)).toBe(2);
    expect(sent.map((m) => m.to).sort()).toEqual(["owner@mehta.in", "partner@mehta.in"]);
    expect(sent[0]!.subject).toBe("Invoice OM/FY2026-27/0001 issued");
    expect(new Set(sent.map((m) => m.idempotencyKey)).size).toBe(2);
    // Next day nothing new: nothing sent.
    now = new Date("2026-12-02T05:00:00Z");
    const since2 = now;
    await billingNotices(deps());
    expect(await emailBillingNotices(deps(), since2)).toBe(0);
  });

  it("a bounced address doesn't stop the others; no mailer sends nothing", async () => {
    await issued("2026-12-16");
    failFor = "owner@mehta.in";
    const since = now;
    await billingNotices(deps());
    expect(await emailBillingNotices(deps(), since)).toBe(1);
    expect(await emailBillingNotices({ db, now: () => now, mailer: null }, since)).toBe(0);
  });
});

describe("weekly digest", () => {
  it("last week is Monday to Sunday in IST", () => {
    expect(lastWeek(new Date("2026-12-07T03:00:00Z"))).toEqual({ start: "2026-11-30", end: "2026-12-06" }); // Monday 08:30 IST
    expect(lastWeek(new Date("2026-12-06T20:00:00Z"))).toEqual({ start: "2026-11-30", end: "2026-12-06" }); // Monday 01:30 IST
  });

  it("sends counts to admins once per firm and week; closed firms are skipped", async () => {
    now = new Date("2026-12-07T03:00:00Z");
    const asha = uuidv7();
    const ravi = uuidv7();
    await db.insert(employees).values([
      { id: asha, firmId, name: "Asha", email: "asha@mehta.in", status: "active" },
      { id: ravi, firmId, name: "Ravi", email: "ravi@mehta.in", status: "active" },
    ]);
    await db.insert(usageDaily).values([
      { firmId, employeeId: asha, date: "2026-12-01", turns: 30, inputTokens: 1, outputTokens: 1 },
      { firmId, employeeId: asha, date: "2026-12-02", turns: 12, inputTokens: 1, outputTokens: 1 },
      { firmId, employeeId: ravi, date: "2026-11-20", turns: 50, inputTokens: 1, outputTokens: 1 }, // not last week
    ]);
    await db
      .insert(servers)
      .values({ id: uuidv7(), firmId, hostname: "RDS01", publicKey: "k", health: "green", enrolledAt: now });
    await issued("2026-12-16");
    const closed = uuidv7();
    await db.insert(firms).values({
      id: closed,
      name: "Old",
      legalName: "Old",
      stateCode: "27",
      billingEmail: "x@y.in",
      status: "closed",
    });
    await db
      .insert(firmAdmins)
      .values({ id: uuidv7(), firmId: closed, email: "old@old.in", name: "Old", role: "owner" });

    expect(await weeklyDigests(deps())).toBe(2);
    expect(await weeklyDigests(deps())).toBe(0); // once per week
    const body = sent[0]!.text;
    expect(sent[0]!.subject).toBe("Off Manual weekly summary for Mehta");
    expect(body).toContain("week of 30-11-2026 to 06-12-2026");
    expect(body).toContain("People using Off Manual: 1 of 2");
    expect(body).toContain("Questions and tasks handled: 42");
    expect(body).toContain("Servers healthy: 1 of 1");
    expect(body).toContain("OM/FY2026-27/0001: ₹2,360.00 due on 16-12-2026");
    expect(sent.some((m) => m.to === "old@old.in")).toBe(false);
  });

  it("text without open invoices", () => {
    const t = digestText({
      firm: "Shah",
      weekStart: "2026-11-30",
      weekEnd: "2026-12-06",
      activeEmployees: 0,
      totalEmployees: 3,
      turns: 0,
      serversHealthy: 0,
      serversTotal: 1,
      openInvoices: [],
    });
    expect(t.text).not.toContain("Invoices to pay");
  });
});
