// Daily billing job (BILLING §3, §6; ADR-045). Vercel Cron calls GET with
// `Authorization: Bearer <CRON_SECRET>` (vercel.com/docs/cron-jobs/manage-cron-jobs,
// "Securing cron jobs"). Every day: firm statuses from the ladder. On the 1st (IST):
// drafts for the previous month. Issuing stays a superadmin action.
import { timingSafeEqual } from "node:crypto";
import { firms } from "@/db/schema";
import { billingNotices } from "../notices";
import { istDate, refreshFirmStatus, runMonth, type BillingConfig, type BillingDeps } from "./run";

export function bearerOk(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Previous calendar month of an IST date. */
export function previousMonth(today: string): { year: number; month: number } {
  const [y, m] = today.split("-").map(Number) as [number, number];
  return m === 1 ? { year: y - 1, month: 12 } : { year: y, month: m - 1 };
}

export async function dailyBilling(
  deps: BillingDeps,
  cfg: BillingConfig,
  secret: string | undefined,
  req: Request,
): Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  if (!bearerOk(req.headers.get("authorization"), secret)) return json(401, { error: "unauthorised" });
  const today = istDate(deps.now());
  let drafts = 0;
  if (today.endsWith("-01")) {
    const { year, month } = previousMonth(today);
    drafts = (await runMonth(deps, cfg, year, month)).drafts;
  }
  const noticesCreated = await billingNotices(deps); // due soon / due today / overdue (ADR-052)
  const ids = await deps.db.select({ id: firms.id }).from(firms);
  let changed = 0;
  for (const f of ids) if ((await refreshFirmStatus(deps, f.id)) !== null) changed++;
  return json(200, {
    date: today,
    drafts,
    firmsChecked: ids.length,
    firmsWithContract: changed,
    noticesCreated,
  });
}
