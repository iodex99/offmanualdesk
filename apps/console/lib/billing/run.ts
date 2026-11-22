// Invoice run, issuing, payments and the ladder → firm status (docs/BILLING.md §3,
// §6; ADR-045). The money maths stays in the pure engine (engine.ts); this file
// loads rows, calls it, and stores the result.
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { fyLabel, invoiceNumber } from "@offmanual/shared-schema/format";
import {
  contractLines,
  contracts,
  employees,
  firms,
  invoiceCounters,
  invoiceLines,
  invoices,
  ladderOverrides,
  payments,
  usageDaily,
} from "@/db/schema";
import type { DB } from "../db";
import { uuidv7 } from "../ids";
import { computeInvoice, monthBounds, type ContractLine, type SeatCountMode, type SeatDay } from "./engine";
import { ladderState, type FirmBillingState } from "./ladder";

export interface BillingDeps {
  db: DB;
  now: () => Date;
}

export interface BillingConfig {
  /** Off Manual's GSTIN; invoices stay drafts until it is configured (BILLING §2). */
  gstin: string | null;
  offManualStateCode: string;
  gstRatePct: string;
}

export function billingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  return {
    gstin: env.OFFMANUAL_GSTIN?.trim() || null,
    offManualStateCode: env.OFFMANUAL_STATE_CODE?.trim() || "27",
    gstRatePct: env.OFFMANUAL_GST_RATE_PCT?.trim() || "18",
  };
}

export class BillingError extends Error {}

// ---- dates (IST business dates "YYYY-MM-DD") ----

const IST_MS = 5.5 * 3600 * 1000;
export function istDate(d: Date): string {
  return new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}
const minDay = (a: string, b?: string | null) => (b && b < a ? b : a);

// ---- contract lines (jsonb → engine) ----

const paise = z
  .string()
  .regex(/^-?\d{1,15}$/)
  .transform((s) => BigInt(s));
const pct = z.string().regex(/^-?\d{1,3}(\.\d{1,2})?$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const common = { label: z.string().min(1).max(200), sac: z.string().regex(/^\d{4,8}$/), startsOn: day };
const specSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("one_time"), amountPaise: paise, ...common }).strict(),
  z
    .object({
      type: z.literal("recurring_flat"),
      amountPaise: paise,
      interval: z.enum(["month", "quarter", "year"]),
      endsOn: day.optional(),
      ...common,
    })
    .strict(),
  z
    .object({
      type: z.literal("per_seat"),
      ratePaise: paise.optional(),
      bands: z
        .array(
          z
            .object({
              from: z.number().int().min(1),
              to: z.number().int().min(1).nullable(),
              ratePaise: paise,
            })
            .strict(),
        )
        .optional(),
      endsOn: day.optional(),
      ...common,
    })
    .strict(),
  z
    .object({
      type: z.literal("usage"),
      ratePer1MTokensPaise: paise,
      includedTokens: z
        .string()
        .regex(/^\d{1,15}$/)
        .transform((s) => BigInt(s)),
      markupPct: pct,
      endsOn: day.optional(),
      ...common,
    })
    .strict(),
  z
    .object({
      type: z.literal("adjustment"),
      pct: pct.optional(),
      amountPaise: paise.optional(),
      endsOn: day.optional(),
      ...common,
    })
    .strict(),
]);

/** Validates a stored line spec (also used when an admin saves a contract). */
export function parseLineSpec(
  id: string,
  spec: unknown,
  versionEndsOn: string | null,
  billed: boolean,
): ContractLine {
  const r = specSchema.safeParse(spec);
  if (!r.success) throw new BillingError(`contract line ${id} is invalid`);
  const s = r.data;
  // A line never outlives its contract version (mid-month changes prorate by version).
  const endsOn = "endsOn" in s && s.endsOn ? minDay(s.endsOn, versionEndsOn) : (versionEndsOn ?? undefined);
  switch (s.type) {
    case "one_time":
      return { id, ...s, alreadyBilled: billed };
    case "per_seat":
      if (!s.ratePaise && !s.bands?.length)
        throw new BillingError(`contract line ${id} needs a rate or bands`);
      return { id, ...s, ...(endsOn ? { endsOn } : {}) } as ContractLine;
    default:
      return { id, ...s, ...(endsOn ? { endsOn } : {}) } as ContractLine;
  }
}

// ---- seat days ----

/**
 * Seats per day from employee records: enabled from binding (or enabled_from) until
 * disabled; active = enabled and had at least one turn that day (usage_daily).
 */
export async function seatDaysFor(db: DB, firmId: string, start: string, end: string): Promise<SeatDay[]> {
  const emps = await db
    .select({
      id: employees.id,
      boundAt: employees.boundAt,
      enabledFrom: employees.enabledFrom,
      disabledAt: employees.disabledAt,
    })
    .from(employees)
    .where(eq(employees.firmId, firmId));
  const used = await db
    .select({ employeeId: usageDaily.employeeId, date: usageDaily.date })
    .from(usageDaily)
    .where(
      and(
        eq(usageDaily.firmId, firmId),
        gte(usageDaily.date, start),
        lte(usageDaily.date, end),
        sql`${usageDaily.turns} > 0`,
      ),
    );
  const active = new Set(used.map((u) => `${u.employeeId}|${u.date}`));
  const out: SeatDay[] = [];
  for (const e of emps) {
    const from = e.enabledFrom ?? (e.boundAt ? istDate(e.boundAt) : null);
    if (!from) continue; // never bound: not a seat
    const until = e.disabledAt ? addDays(istDate(e.disabledAt), -1) : null; // the disable day isn't billed
    for (const d of eachDay(start, end)) {
      const enabled = d >= from && (!until || d <= until);
      if (enabled) out.push({ employeeId: e.id, date: d, enabled, active: active.has(`${e.id}|${d}`) });
    }
  }
  return out;
}

// ---- the run ----

async function versionsFor(db: DB, firmId: string, start: string, end: string) {
  return db
    .select()
    .from(contracts)
    .where(
      and(
        eq(contracts.firmId, firmId),
        inArray(contracts.status, ["active", "superseded", "ended"]),
        lte(contracts.startsOn, end),
        or(isNull(contracts.endsOn), gte(contracts.endsOn, start)),
      ),
    )
    .orderBy(contracts.version);
}

/**
 * Creates or refreshes the draft invoice of one firm for one month. Issued, paid or
 * void invoices are never touched. Returns null when no contract covers the month.
 */
export async function generateDraft(
  deps: BillingDeps,
  cfg: BillingConfig,
  firmId: string,
  year: number,
  month: number,
): Promise<{ invoiceId: string; totalPaise: bigint } | null> {
  const period = monthBounds(year, month);
  const firm = (await deps.db.select().from(firms).where(eq(firms.id, firmId)))[0];
  if (!firm) throw new BillingError("firm not found");
  const versions = await versionsFor(deps.db, firmId, period.start, period.end);
  if (versions.length === 0) return null;
  const latest = versions[versions.length - 1]!;
  const rows = await deps.db
    .select()
    .from(contractLines)
    .where(
      inArray(
        contractLines.contractId,
        versions.map((v) => v.id),
      ),
    );
  const endOf = new Map(versions.map((v) => [v.id, v.endsOn]));
  const lines = rows.map((r) =>
    parseLineSpec(r.id, r.spec, endOf.get(r.contractId) ?? null, r.billedInvoiceId !== null),
  );
  const usage = (
    await deps.db
      .select({ t: sql<string>`coalesce(sum(${usageDaily.inputTokens} + ${usageDaily.outputTokens}), 0)` })
      .from(usageDaily)
      .where(
        and(
          eq(usageDaily.firmId, firmId),
          gte(usageDaily.date, period.start),
          lte(usageDaily.date, period.end),
        ),
      )
  )[0]!.t;
  const inv = computeInvoice({
    contract: {
      seatCountMode: latest.seatCountMode as SeatCountMode,
      bandsMode: latest.bandsMode === "volume" ? "volume" : "tiered",
      lines,
    },
    year,
    month,
    seatDays: await seatDaysFor(deps.db, firmId, period.start, period.end),
    usageTokens: firm.llmKeyMode === "offmanual" ? BigInt(usage) : 0n, // ADR-011: own key → no usage line
    firmStateCode: firm.stateCode,
    offManualStateCode: cfg.offManualStateCode,
    gstRatePct: cfg.gstRatePct,
  });

  return deps.db.transaction(async (tx) => {
    const existing = (
      await tx
        .select({ id: invoices.id, status: invoices.status, total: invoices.totalPaise })
        .from(invoices)
        .where(and(eq(invoices.firmId, firmId), eq(invoices.periodStart, period.start)))
    )[0];
    if (existing && existing.status !== "draft")
      return { invoiceId: existing.id, totalPaise: existing.total };
    const id = existing?.id ?? uuidv7();
    const values = {
      taxablePaise: inv.taxablePaise,
      cgstPaise: inv.cgstPaise,
      sgstPaise: inv.sgstPaise,
      igstPaise: inv.igstPaise,
      totalPaise: inv.totalPaise,
      updatedAt: deps.now(),
    };
    if (existing) {
      await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, id));
      await tx.update(invoices).set(values).where(eq(invoices.id, id));
    } else {
      await tx
        .insert(invoices)
        .values({ id, firmId, periodStart: period.start, periodEnd: period.end, ...values });
    }
    if (inv.lines.length > 0) {
      await tx.insert(invoiceLines).values(
        inv.lines.map((l) => ({
          id: uuidv7(),
          invoiceId: id,
          contractLineId: l.lineId,
          description: l.description,
          sac: l.sac,
          quantity: l.quantity,
          amountPaise: l.amountPaise,
        })),
      );
    }
    return { invoiceId: id, totalPaise: inv.totalPaise };
  });
}

/** Monthly run (BILLING §3): drafts for every firm with a contract covering the month. */
export async function runMonth(deps: BillingDeps, cfg: BillingConfig, year: number, month: number) {
  const period = monthBounds(year, month);
  const firmIds = await deps.db
    .selectDistinct({ id: contracts.firmId })
    .from(contracts)
    .where(
      and(
        inArray(contracts.status, ["active", "superseded", "ended"]),
        lte(contracts.startsOn, period.end),
        or(isNull(contracts.endsOn), gte(contracts.endsOn, period.start)),
      ),
    );
  let drafts = 0;
  for (const f of firmIds) if (await generateDraft(deps, cfg, f.id, year, month)) drafts++;
  return { drafts };
}

/** Issues a draft: FY number, issue/due dates, one-time lines marked billed. */
export async function issueInvoice(
  deps: BillingDeps,
  cfg: BillingConfig,
  invoiceId: string,
): Promise<string> {
  if (!cfg.gstin)
    throw new BillingError("Set OFFMANUAL_GSTIN (confirmed with the CA) before issuing invoices.");
  const now = deps.now();
  const today = istDate(now);
  return deps.db.transaction(async (tx) => {
    const inv = (await tx.select().from(invoices).where(eq(invoices.id, invoiceId)))[0];
    if (!inv) throw new BillingError("invoice not found");
    if (inv.status !== "draft") throw new BillingError("only a draft can be issued");
    const terms = (
      await tx
        .select({ days: contracts.paymentTermsDays })
        .from(contracts)
        .where(
          and(
            eq(contracts.firmId, inv.firmId),
            lte(contracts.startsOn, inv.periodEnd),
            inArray(contracts.status, ["active", "superseded", "ended"]),
          ),
        )
        .orderBy(desc(contracts.version))
        .limit(1)
    )[0];
    const fy = fyLabel(now);
    await tx.insert(invoiceCounters).values({ fy, lastSeq: 0 }).onConflictDoNothing();
    const [c] = await tx
      .update(invoiceCounters)
      .set({ lastSeq: sql`${invoiceCounters.lastSeq} + 1` })
      .where(eq(invoiceCounters.fy, fy))
      .returning({ seq: invoiceCounters.lastSeq });
    const number = invoiceNumber(now, c!.seq);
    await tx
      .update(invoices)
      .set({
        number,
        status: "issued",
        issuedOn: today,
        dueOn: addDays(today, terms?.days ?? 15),
        updatedAt: now,
      })
      .where(eq(invoices.id, invoiceId));
    const billed = await tx
      .select({ id: invoiceLines.contractLineId })
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoiceId));
    const ids = billed.map((b) => b.id).filter((x): x is string => !!x);
    if (ids.length > 0) {
      await tx
        .update(contractLines)
        .set({ billedInvoiceId: invoiceId })
        .where(
          and(
            inArray(contractLines.id, ids),
            sql`${contractLines.spec}->>'type' = 'one_time'`,
            isNull(contractLines.billedInvoiceId),
          ),
        );
    }
    return number;
  });
}

/** Records a payment; the invoice becomes paid once payments cover the total. */
export async function recordPayment(
  deps: BillingDeps,
  p: {
    invoiceId: string;
    amountPaise: bigint;
    paidAt: Date;
    provider: "manual" | "razorpay";
    method?: string;
    providerRef?: string;
    recordedBy?: string;
  },
): Promise<"paid" | "issued"> {
  if (p.amountPaise <= 0n) throw new BillingError("amount must be positive");
  return deps.db.transaction(async (tx) => {
    const inv = (await tx.select().from(invoices).where(eq(invoices.id, p.invoiceId)))[0];
    if (!inv || (inv.status !== "issued" && inv.status !== "paid"))
      throw new BillingError("only an issued invoice can be paid");
    await tx.insert(payments).values({
      id: uuidv7(),
      invoiceId: p.invoiceId,
      provider: p.provider,
      providerRef: p.providerRef ?? null,
      amountPaise: p.amountPaise,
      paidAt: p.paidAt,
      method: p.method ?? null,
      recordedBy: p.recordedBy ?? null,
    });
    const sum = (
      await tx
        .select({ s: sql<string>`coalesce(sum(${payments.amountPaise}), 0)` })
        .from(payments)
        .where(eq(payments.invoiceId, p.invoiceId))
    )[0]!.s;
    const status = BigInt(sum) >= inv.totalPaise ? "paid" : "issued";
    await tx.update(invoices).set({ status, updatedAt: deps.now() }).where(eq(invoices.id, p.invoiceId));
    return status;
  });
}

/**
 * Daily: firm status from the ladder (BILLING §6), which the Server Agent enforces
 * (ADR-042). Firms without a contract, still on trial, or closed are left alone.
 */
export async function refreshFirmStatus(deps: BillingDeps, firmId: string): Promise<FirmBillingState | null> {
  const today = istDate(deps.now());
  const firm = (await deps.db.select({ status: firms.status }).from(firms).where(eq(firms.id, firmId)))[0];
  if (!firm || firm.status === "closed") return null;
  const contract = (
    await deps.db
      .select()
      .from(contracts)
      .where(
        and(
          eq(contracts.firmId, firmId),
          lte(contracts.startsOn, today),
          inArray(contracts.status, ["active", "superseded", "ended"]),
        ),
      )
      .orderBy(desc(contracts.version))
      .limit(1)
  )[0];
  if (!contract) return null;
  const open = await deps.db
    .select({ dueOn: invoices.dueOn, status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.firmId, firmId), inArray(invoices.status, ["issued", "paid"])));
  const override = (
    await deps.db
      .select()
      .from(ladderOverrides)
      .where(
        and(
          eq(ladderOverrides.firmId, firmId),
          or(isNull(ladderOverrides.until), gte(ladderOverrides.until, today)),
        ),
      )
      .orderBy(desc(ladderOverrides.createdAt))
      .limit(1)
  )[0];
  const r = ladderState(
    open.filter((i) => i.dueOn).map((i) => ({ dueOn: i.dueOn!, paid: i.status === "paid" })),
    today,
    { graceDays: contract.graceDays, suspendAfterDays: contract.suspendAfterDays },
    override
      ? {
          state: override.state as FirmBillingState,
          reason: override.reason,
          ...(override.until ? { until: override.until } : {}),
        }
      : undefined,
  );
  if (firm.status !== r.state) {
    await deps.db.update(firms).set({ status: r.state, updatedAt: deps.now() }).where(eq(firms.id, firmId));
  }
  return r.state;
}
