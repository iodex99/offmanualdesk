// Billing operations for the console API (BILLING §3–§6). Superadmin runs, issues,
// records payments and overrides; a firm admin can only read their own invoices.
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { firms, invoiceLines, invoices, ladderOverrides } from "@/db/schema";
import { renderInvoicePdf } from "./pdf";
import { InputError } from "../admin";
import { requireConsole, requireFirmAccess, type SessionState } from "../auth";
import { uuidv7 } from "../ids";
import {
  BillingError,
  issueInvoice,
  recordPayment,
  refreshFirmStatus,
  runMonth,
  type BillingConfig,
  type BillingDeps,
} from "./run";

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const actionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("run"),
      year: z.number().int().min(2026).max(2100),
      month: z.number().int().min(1).max(12),
    })
    .strict(),
  z.object({ action: z.literal("issue"), invoiceId: uuid }).strict(),
  z
    .object({
      action: z.literal("payment"),
      invoiceId: uuid,
      amountPaise: z.string().regex(/^\d{1,15}$/),
      paidOn: day,
      method: z.string().max(40).optional(),
      reference: z.string().max(80).optional(),
    })
    .strict(),
  z.object({ action: z.literal("refresh"), firmId: uuid.optional() }).strict(),
  z
    .object({
      action: z.literal("override"),
      firmId: uuid,
      state: z.enum(["active", "overdue", "restricted", "suspended"]),
      reason: z.string().trim().min(5).max(300),
      until: day.optional(),
    })
    .strict(),
]);

/** POST /api/admin/billing */
export async function billingAction(
  deps: BillingDeps,
  cfg: BillingConfig,
  s: SessionState | null,
  body: unknown,
) {
  const p = requireConsole(s, ["superadmin"]);
  const r = actionSchema.safeParse(body);
  if (!r.success) throw new InputError("Some details are missing or not in the right format.");
  const a = r.data;
  try {
    switch (a.action) {
      case "run":
        return await runMonth(deps, cfg, a.year, a.month);
      case "issue":
        return { number: await issueInvoice(deps, cfg, a.invoiceId) };
      case "payment":
        return {
          status: await recordPayment(deps, {
            invoiceId: a.invoiceId,
            amountPaise: BigInt(a.amountPaise),
            paidAt: new Date(`${a.paidOn}T06:30:00Z`), // noon IST on the day paid
            provider: "manual",
            ...(a.method ? { method: a.method } : {}),
            ...(a.reference ? { providerRef: a.reference } : {}),
            recordedBy: p.userId,
          }),
        };
      case "refresh": {
        const ids = a.firmId
          ? [a.firmId]
          : (await deps.db.select({ id: firms.id }).from(firms)).map((f) => f.id);
        const states: Record<string, string | null> = {};
        for (const id of ids) states[id] = await refreshFirmStatus(deps, id);
        return { states };
      }
      case "override":
        await deps.db.insert(ladderOverrides).values({
          id: uuidv7(),
          firmId: a.firmId,
          state: a.state,
          reason: a.reason,
          until: a.until ?? null,
          createdBy: p.userId,
        });
        return { state: await refreshFirmStatus(deps, a.firmId) };
    }
  } catch (e) {
    if (e instanceof BillingError) throw new InputError(e.message);
    throw e;
  }
}

/** GET /api/admin/firms/[firmId]/invoices: the firm's issued and paid invoices (drafts are Off Manual's). */
export async function listInvoices(deps: BillingDeps, s: SessionState | null, firmId: string) {
  const p = requireFirmAccess(s, firmId);
  const statuses =
    p.kind === "console" ? (["draft", "issued", "paid", "void"] as const) : (["issued", "paid"] as const);
  const rows = await deps.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.firmId, firmId), inArray(invoices.status, [...statuses])))
    .orderBy(desc(invoices.periodStart));
  return {
    invoices: rows.map((i) => ({
      id: i.id,
      number: i.number,
      periodStart: i.periodStart,
      periodEnd: i.periodEnd,
      issuedOn: i.issuedOn,
      dueOn: i.dueOn,
      status: i.status,
      // Money as decimal strings: JSON has no bigint.
      taxablePaise: i.taxablePaise.toString(),
      gstPaise: (i.cgstPaise + i.sgstPaise + i.igstPaise).toString(),
      totalPaise: i.totalPaise.toString(),
    })),
  };
}

/** Superadmin billing board: every firm's invoices, newest period first (money as strings). */
export async function billingBoard(deps: BillingDeps, s: SessionState | null) {
  requireConsole(s, ["superadmin"]);
  const rows = await deps.db
    .select({
      id: invoices.id,
      firm: firms.name,
      firmId: invoices.firmId,
      number: invoices.number,
      periodStart: invoices.periodStart,
      dueOn: invoices.dueOn,
      status: invoices.status,
      totalPaise: invoices.totalPaise,
    })
    .from(invoices)
    .innerJoin(firms, eq(firms.id, invoices.firmId))
    .orderBy(desc(invoices.periodStart), firms.name);
  const firmRows = await deps.db
    .select({ id: firms.id, name: firms.name, status: firms.status })
    .from(firms)
    .orderBy(firms.name);
  return {
    invoices: rows.map((r) => ({ ...r, totalPaise: r.totalPaise.toString() })),
    firms: firmRows,
  };
}

/** The invoice as a PDF. Firm admins get issued/paid invoices of their own firm only. */
export async function invoicePdf(
  deps: BillingDeps,
  cfg: BillingConfig,
  s: SessionState | null,
  firmId: string,
  invoiceId: string,
): Promise<{ filename: string; bytes: Uint8Array }> {
  const p = requireFirmAccess(s, firmId);
  const inv = (
    await deps.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.firmId, firmId)))
  )[0];
  if (!inv || (p.kind !== "console" && inv.status !== "issued" && inv.status !== "paid")) {
    throw new InputError("That invoice doesn't exist.");
  }
  const firm = (await deps.db.select().from(firms).where(eq(firms.id, firmId)))[0]!;
  const lines = await deps.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
  const bytes = await renderInvoicePdf(
    {
      number: inv.number,
      issuedOn: inv.issuedOn,
      dueOn: inv.dueOn,
      periodStart: inv.periodStart,
      periodEnd: inv.periodEnd,
      seller: {
        legalName: cfg.legalName ?? "Off Manual",
        address: cfg.address ?? "",
        gstin: cfg.gstin,
        stateCode: cfg.offManualStateCode,
      },
      buyer: { legalName: firm.legalName, gstin: firm.gstin, stateCode: firm.stateCode },
      lines: lines.map((l) => ({
        description: l.description,
        sac: l.sac,
        quantity: l.quantity,
        amountPaise: l.amountPaise,
      })),
      taxablePaise: inv.taxablePaise,
      cgstPaise: inv.cgstPaise,
      sgstPaise: inv.sgstPaise,
      igstPaise: inv.igstPaise,
      totalPaise: inv.totalPaise,
      gstRatePct: cfg.gstRatePct,
    },
    deps.now(),
  );
  const filename = `${(inv.number ?? `draft-${inv.periodStart}`).replace(/[^A-Za-z0-9-]+/g, "-")}.pdf`;
  return { filename, bytes };
}
