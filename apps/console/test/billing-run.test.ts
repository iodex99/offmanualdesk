// Invoice run against PGlite. Figures worked by hand (November 2026 has 30 days;
// Off Manual and the firm both in Maharashtra, 27 → CGST + SGST 9% each).
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consoleUsers,
  contractLines,
  contracts,
  employees,
  firms,
  invoiceLines,
  invoices,
  ladderOverrides,
  usageDaily,
} from "@/db/schema";
import {
  BillingError,
  generateDraft,
  issueInvoice,
  parseLineSpec,
  recordPayment,
  refreshFirmStatus,
  runMonth,
  seatDaysFor,
  type BillingConfig,
} from "@/lib/billing/run";
import type { SessionState } from "@/lib/auth";
import { billingAction, billingBoard, listInvoices } from "@/lib/billing/admin";
import { dailyBilling, previousMonth } from "@/lib/billing/cron";
import { rupeesToPaise } from "@/app/billing/forms";
import type { DB } from "@/lib/db";
import { uuidv7 } from "@/lib/ids";
import { testDb } from "./helpers/db";

let db: DB;
let close: () => Promise<void>;
let now = new Date("2026-12-01T03:00:00Z"); // 08:30 IST, 1 December
const deps = () => ({ db, now: () => now });
const cfg: BillingConfig = { gstin: "27AAAAA0000A1Z5", offManualStateCode: "27", gstRatePct: "18" };
let firmId: string;

async function contract(
  version: number,
  startsOn: string,
  endsOn: string | null,
  specs: Record<string, unknown>[],
  status = "active",
) {
  const id = uuidv7();
  await db.insert(contracts).values({
    id,
    firmId,
    version,
    startsOn,
    endsOn,
    status: status as "active",
    paymentTermsDays: 15,
    graceDays: 15,
    suspendAfterDays: 45,
  });
  const lineIds: string[] = [];
  for (const spec of specs) {
    const lid = uuidv7();
    lineIds.push(lid);
    await db.insert(contractLines).values({ id: lid, contractId: id, spec });
  }
  return { id, lineIds };
}

async function employee(boundAt: string | null, disabledAt?: string) {
  const id = uuidv7();
  await db.insert(employees).values({
    id,
    firmId,
    name: "E",
    email: `${id}@x.in`,
    status: disabledAt ? "disabled" : "active",
    boundAt: boundAt ? new Date(`${boundAt}T05:00:00Z`) : null,
    disabledAt: disabledAt ? new Date(`${disabledAt}T05:00:00Z`) : null,
  });
  return id;
}

const SETUP = {
  type: "one_time",
  label: "Setup",
  sac: "998313",
  amountPaise: "5000000",
  startsOn: "2026-10-01",
};
const AMC = {
  type: "recurring_flat",
  label: "AMC",
  sac: "998313",
  amountPaise: "200000",
  interval: "month",
  startsOn: "2026-10-01",
};
const SEATS = {
  type: "per_seat",
  label: "Seats",
  sac: "998313",
  ratePaise: "150000",
  startsOn: "2026-10-01",
};

beforeEach(async () => {
  ({ db, close } = await testDb());
  now = new Date("2026-12-01T03:00:00Z");
  firmId = uuidv7();
  await db.insert(firms).values({
    id: firmId,
    name: "Mehta",
    legalName: "Mehta LLP",
    stateCode: "27",
    billingEmail: "a@b.in",
    status: "active",
  });
});
afterEach(async () => close());

describe("seat days", () => {
  it("count from binding until the day before disabling; never-bound employees aren't seats", async () => {
    await employee("2026-09-15");
    await employee("2026-11-16");
    await employee(null);
    await employee("2026-10-01", "2026-11-11"); // enabled 1–10 Nov
    const days = await seatDaysFor(db, firmId, "2026-11-01", "2026-11-30");
    expect(days).toHaveLength(30 + 15 + 10);
  });
});

describe("generateDraft", () => {
  it("bills setup, AMC and prorated seats with CGST+SGST", async () => {
    await contract(1, "2026-10-01", null, [SETUP, AMC, SEATS]);
    await employee("2026-09-15");
    await employee("2026-11-16");
    const r = await generateDraft(deps(), cfg, firmId, 2026, 11);
    // 50,000 + 2,000 + 1.5 seats × 1,500 = 54,250 taxable; 9% + 9% = 4,882.50 each.
    const inv = (await db.select().from(invoices).where(eq(invoices.id, r!.invoiceId)))[0]!;
    expect(inv).toMatchObject({
      taxablePaise: 5425000n,
      cgstPaise: 488250n,
      sgstPaise: 488250n,
      igstPaise: 0n,
      totalPaise: 6401500n,
      status: "draft",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
    });
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, r!.invoiceId));
    expect(lines.map((l) => [l.description, l.amountPaise]).sort()).toEqual([
      ["AMC", 200000n],
      ["Seats", 225000n],
      ["Setup", 5000000n],
    ]);
  });

  it("a re-run refreshes the draft in place; IGST for another state", async () => {
    await db.update(firms).set({ stateCode: "24" }).where(eq(firms.id, firmId));
    await contract(1, "2026-10-01", null, [AMC]);
    const a = await generateDraft(deps(), cfg, firmId, 2026, 11);
    const b = await generateDraft(deps(), cfg, firmId, 2026, 11);
    expect(b!.invoiceId).toBe(a!.invoiceId);
    const inv = (await db.select().from(invoices).where(eq(invoices.firmId, firmId)))[0]!;
    expect(inv).toMatchObject({ igstPaise: 36000n, cgstPaise: 0n, totalPaise: 236000n });
    expect(await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, a!.invoiceId))).toHaveLength(
      1,
    );
  });

  it("mid-month contract change prorates seats by version", async () => {
    await contract(1, "2026-10-01", "2026-11-15", [{ ...SEATS, startsOn: "2026-10-01" }], "superseded");
    await contract(2, "2026-11-16", null, [{ ...SEATS, ratePaise: "200000", startsOn: "2026-11-16" }]);
    await employee("2026-09-01");
    const r = await generateDraft(deps(), cfg, firmId, 2026, 11);
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, r!.invoiceId));
    // 15/30 × 1,500 + 15/30 × 2,000 = 750 + 1,000.
    expect(lines.map((l) => l.amountPaise).sort()).toEqual([100000n, 75000n].sort());
  });

  it("usage is billed only on Off Manual's LLM key; no contract → no invoice", async () => {
    await contract(1, "2026-10-01", null, [
      {
        type: "usage",
        label: "AI usage",
        sac: "998315",
        ratePer1MTokensPaise: "10000",
        includedTokens: "1000000",
        markupPct: "10",
        startsOn: "2026-10-01",
      },
    ]);
    const e = await employee("2026-10-01");
    await db.insert(usageDaily).values({
      firmId,
      employeeId: e,
      date: "2026-11-05",
      inputTokens: 2_500_000,
      outputTokens: 500_000,
      turns: 3,
    });
    expect((await generateDraft(deps(), cfg, firmId, 2026, 11))!.totalPaise).toBe(0n);
    await db.update(firms).set({ llmKeyMode: "offmanual" }).where(eq(firms.id, firmId));
    // (3,000,000 − 1,000,000) tokens × ₹100/1M = ₹200 + 10% = ₹220 → +18% GST = ₹259.60.
    expect((await generateDraft(deps(), cfg, firmId, 2026, 11))!.totalPaise).toBe(25960n);
    expect(await generateDraft(deps(), cfg, firmId, 2026, 9)).toBeNull();
  });

  it("refuses invalid line specs", () => {
    expect(() =>
      parseLineSpec(
        "x",
        { type: "one_time", label: "x", sac: "998313", amountPaise: "1.5", startsOn: "2026-10-01" },
        null,
        false,
      ),
    ).toThrow(BillingError);
    expect(() => parseLineSpec("x", { ...SEATS, ratePaise: undefined }, null, false)).toThrow(BillingError);
    expect(() => parseLineSpec("x", { ...AMC, extra: 1 }, null, false)).toThrow(BillingError);
  });
});

describe("issue, pay, ladder", () => {
  it("numbers per FY, bills one-time lines once, then pays", async () => {
    await contract(1, "2026-10-01", null, [SETUP, AMC]);
    const nov = await generateDraft(deps(), cfg, firmId, 2026, 11);
    await expect(issueInvoice(deps(), { ...cfg, gstin: null }, nov!.invoiceId)).rejects.toThrow(
      /OFFMANUAL_GSTIN/,
    );
    expect(await issueInvoice(deps(), cfg, nov!.invoiceId)).toBe("OM/FY2026-27/0001");
    await expect(issueInvoice(deps(), cfg, nov!.invoiceId)).rejects.toThrow(/only a draft/);
    const inv = (await db.select().from(invoices).where(eq(invoices.id, nov!.invoiceId)))[0]!;
    expect(inv).toMatchObject({ status: "issued", issuedOn: "2026-12-01", dueOn: "2026-12-16" });
    // Issued invoices are never recomputed by a later run.
    await runMonth(deps(), cfg, 2026, 11);
    expect((await db.select().from(invoices).where(eq(invoices.id, nov!.invoiceId)))[0]!.number).toBe(
      "OM/FY2026-27/0001",
    );

    now = new Date("2027-01-01T03:00:00Z");
    const dec = await generateDraft(deps(), cfg, firmId, 2026, 12);
    expect(dec!.totalPaise).toBe(236000n); // AMC only: setup was billed in November
    expect(await issueInvoice(deps(), cfg, dec!.invoiceId)).toBe("OM/FY2026-27/0002");

    expect(
      await recordPayment(deps(), {
        invoiceId: nov!.invoiceId,
        amountPaise: 1000000n,
        paidAt: now,
        provider: "manual",
        method: "NEFT",
      }),
    ).toBe("issued");
    expect(
      await recordPayment(deps(), {
        invoiceId: nov!.invoiceId,
        amountPaise: inv.totalPaise - 1000000n,
        paidAt: now,
        provider: "manual",
      }),
    ).toBe("paid");
    await expect(
      recordPayment(deps(), { invoiceId: nov!.invoiceId, amountPaise: 0n, paidAt: now, provider: "manual" }),
    ).rejects.toThrow();
  });

  it("firm status follows the ladder; override wins; closed firms are left alone", async () => {
    await contract(1, "2026-10-01", null, [AMC]);
    const nov = await generateDraft(deps(), cfg, firmId, 2026, 11);
    await issueInvoice(deps(), cfg, nov!.invoiceId); // due 16-12-2026
    const at = async (d: string) => {
      now = new Date(`${d}T03:00:00Z`);
      return refreshFirmStatus(deps(), firmId);
    };
    expect(await at("2026-12-16")).toBe("active");
    expect(await at("2026-12-20")).toBe("overdue");
    expect(await at("2027-01-05")).toBe("restricted"); // 20 days > 15 grace
    expect(await at("2027-02-01")).toBe("suspended"); // 47 days > 45
    expect((await db.select({ s: firms.status }).from(firms).where(eq(firms.id, firmId)))[0]!.s).toBe(
      "suspended",
    );
    await db.insert(ladderOverrides).values({
      id: uuidv7(),
      firmId,
      state: "active",
      reason: "Cheque received, clearing",
      until: "2027-02-05",
    });
    expect(await at("2027-02-02")).toBe("active");
    expect(await at("2027-02-06")).toBe("suspended");
    await recordPayment(deps(), {
      invoiceId: nov!.invoiceId,
      amountPaise: 236000n,
      paidAt: now,
      provider: "manual",
    });
    expect(await at("2027-02-07")).toBe("active");
    await db.update(firms).set({ status: "closed" }).where(eq(firms.id, firmId));
    expect(await at("2027-02-08")).toBeNull();
  });

  it("a firm without a contract keeps its status", async () => {
    await db.update(firms).set({ status: "trial" }).where(eq(firms.id, firmId));
    expect(await refreshFirmStatus(deps(), firmId)).toBeNull();
    expect((await db.select({ s: firms.status }).from(firms).where(eq(firms.id, firmId)))[0]!.s).toBe(
      "trial",
    );
  });
});

// ---- API operations: roles and firm scoping ----

const superadmin: SessionState = {
  principal: { kind: "console", userId: "", email: "d@om.in", name: "D", role: "superadmin" },
  mfa: true,
  token: "t",
};
const staffOnly: SessionState = {
  ...superadmin,
  principal: { ...superadmin.principal, role: "staff" } as SessionState["principal"],
};
const adminOf = (fid: string): SessionState => ({
  principal: { kind: "firm_admin", userId: "fa", email: "o@f.in", name: "O", role: "owner", firmId: fid },
  mfa: true,
  token: "t",
});

describe("billing API operations", () => {
  it("only a superadmin runs, issues and records payments; bad input is refused", async () => {
    const su = {
      ...superadmin,
      principal: { ...superadmin.principal, userId: uuidv7() } as SessionState["principal"],
    };
    await db.insert(consoleUsers).values({
      id: (su.principal as { userId: string }).userId,
      email: "d@om.in",
      name: "D",
      role: "superadmin",
    });
    await contract(1, "2026-10-01", null, [AMC]);
    await expect(
      billingAction(deps(), cfg, staffOnly, { action: "run", year: 2026, month: 11 }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      billingAction(deps(), cfg, adminOf(firmId), { action: "run", year: 2026, month: 11 }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      billingAction(deps(), cfg, null, { action: "run", year: 2026, month: 11 }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(billingAction(deps(), cfg, su, { action: "run", year: 2026, month: 13 })).rejects.toThrow(
      /right format/,
    );
    expect(await billingAction(deps(), cfg, su, { action: "run", year: 2026, month: 11 })).toEqual({
      drafts: 1,
    });
    const inv = (await db.select().from(invoices).where(eq(invoices.firmId, firmId)))[0]!;
    // A firm admin doesn't see Off Manual's drafts.
    expect((await listInvoices(deps(), adminOf(firmId), firmId)).invoices).toHaveLength(0);
    expect(await billingAction(deps(), cfg, su, { action: "issue", invoiceId: inv.id })).toEqual({
      number: "OM/FY2026-27/0001",
    });
    await expect(
      billingAction(deps(), { ...cfg, gstin: null }, su, { action: "issue", invoiceId: inv.id }),
    ).rejects.toThrow(/OFFMANUAL_GSTIN/);
    await expect(billingAction(deps(), cfg, su, { action: "issue", invoiceId: inv.id })).rejects.toThrow(
      /only a draft/,
    );
    const listed = await listInvoices(deps(), adminOf(firmId), firmId);
    expect(listed.invoices[0]).toMatchObject({
      number: "OM/FY2026-27/0001",
      totalPaise: "236000",
      gstPaise: "36000",
    });
    expect(JSON.parse(JSON.stringify(listed))).toEqual(listed); // JSON-safe (no bigint)
    expect(
      await billingAction(deps(), cfg, su, {
        action: "payment",
        invoiceId: inv.id,
        amountPaise: "236000",
        paidOn: "2026-12-05",
        method: "NEFT",
      }),
    ).toEqual({ status: "paid" });
    await expect(
      billingAction(deps(), cfg, su, { action: "override", firmId, state: "suspended", reason: "x" }),
    ).rejects.toThrow(/right format/); // a reason is required
    expect(
      await billingAction(deps(), cfg, su, {
        action: "override",
        firmId,
        state: "suspended",
        reason: "Contract terminated by firm",
      }),
    ).toEqual({ state: "suspended" });
  });

  it("a firm admin can't read another firm's invoices", async () => {
    await expect(listInvoices(deps(), adminOf(uuidv7()), firmId)).rejects.toMatchObject({ status: 403 });
  });
});

describe("daily billing cron", () => {
  const SECRET = "0123456789abcdef-cron";
  const req = (auth?: string) =>
    new Request("https://c.test/api/cron/billing", auth ? { headers: { authorization: auth } } : {});

  it("needs the secret; on the 1st makes last month's drafts; refreshes statuses", async () => {
    await contract(1, "2026-10-01", null, [AMC]);
    expect((await dailyBilling(deps(), cfg, SECRET, req())).status).toBe(401);
    expect((await dailyBilling(deps(), cfg, SECRET, req("Bearer wrong-secret-xxxxx"))).status).toBe(401);
    expect((await dailyBilling(deps(), cfg, undefined, req(`Bearer ${SECRET}`))).status).toBe(401);
    now = new Date("2026-11-30T20:00:00Z"); // 01:30 IST on 1 December
    const r = await dailyBilling(deps(), cfg, SECRET, req(`Bearer ${SECRET}`));
    expect(await r.json()).toEqual({ date: "2026-12-01", drafts: 1, firmsChecked: 1, firmsWithContract: 1 });
    now = new Date("2026-12-02T20:00:00Z");
    expect(await (await dailyBilling(deps(), cfg, SECRET, req(`Bearer ${SECRET}`))).json()).toMatchObject({
      drafts: 0,
    });
  });

  it("previous month wraps the year", () => {
    expect(previousMonth("2027-01-01")).toEqual({ year: 2026, month: 12 });
    expect(previousMonth("2026-12-01")).toEqual({ year: 2026, month: 11 });
  });
});

describe("billing board", () => {
  it("superadmin only; lists invoices with firm names and string money", async () => {
    await contract(1, "2026-10-01", null, [AMC]);
    await generateDraft(deps(), cfg, firmId, 2026, 11);
    const b = await billingBoard(deps(), superadmin);
    expect(b.invoices).toHaveLength(1);
    expect(b.invoices[0]).toMatchObject({
      firm: "Mehta",
      status: "draft",
      totalPaise: "236000",
      number: null,
    });
    expect(b.firms.map((f) => f.name)).toEqual(["Mehta"]);
    await expect(billingBoard(deps(), staffOnly)).rejects.toMatchObject({ status: 403 });
    await expect(billingBoard(deps(), adminOf(firmId))).rejects.toMatchObject({ status: 403 });
  });
});

describe("rupee input", () => {
  it("converts rupees to paise strictly", () => {
    expect(rupeesToPaise("2360")).toBe("236000");
    expect(rupeesToPaise("2360.5")).toBe("236050");
    expect(rupeesToPaise(" 0.05 ")).toBe("5");
    for (const bad of ["", "0", "1.234", "-5", "1,000", "abc"]) expect(rupeesToPaise(bad), bad).toBeNull();
  });
});
