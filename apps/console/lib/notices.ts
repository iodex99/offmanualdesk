// Notices shown in Desk (BILLING §5, UPDATES §4, ADR-052). Staff post to one firm or
// all; a firm admin posts to their own firm only. Billing notices are generated once
// per invoice and stage (dedupe key). Plain text, no client data.
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { firms, invoices, notices } from "@/db/schema";
import { formatDate, formatINR } from "@offmanual/shared-schema/format";
import { InputError } from "./admin";
import { requireConsole, requireFirmAccess, type SessionState } from "./auth";
import type { DB } from "./db";
import { uuidv7 } from "./ids";

export interface NoticeDeps {
  db: DB;
  now: () => Date;
}

const noticeInput = z
  .object({
    firmId: z.string().uuid().nullable(),
    audience: z.enum(["all", "admins"]).default("all"),
    title: z.string().trim().min(3).max(80),
    body: z.string().trim().min(1).max(500),
    endsAt: z.string().datetime().optional(),
  })
  .strict();

/** POST /api/admin/notices */
export async function postNotice(deps: NoticeDeps, s: SessionState | null, input: unknown) {
  const r = noticeInput.safeParse(input);
  if (!r.success) throw new InputError("Some details are missing or not in the right format.");
  const n = r.data;
  if (n.firmId === null)
    requireConsole(s); // all firms: Off Manual staff only
  else requireFirmAccess(s, n.firmId);
  const p = s!.principal;
  const id = uuidv7();
  await deps.db.insert(notices).values({
    id,
    firmId: n.firmId,
    kind: p.kind === "console" ? "update" : "admin",
    audience: n.audience,
    title: n.title,
    body: n.body,
    startsAt: deps.now(),
    endsAt: n.endsAt ? new Date(n.endsAt) : null,
    createdBy: p.userId || null,
  });
  return { id };
}

/** Active notices for a firm (its own and all-firm ones), for the agent feed. */
export async function activeNotices(db: DB, firmId: string, now: Date) {
  return db
    .select({
      id: notices.id,
      kind: notices.kind,
      audience: notices.audience,
      title: notices.title,
      body: notices.body,
      startsAt: notices.startsAt,
    })
    .from(notices)
    .where(
      and(
        or(eq(notices.firmId, firmId), isNull(notices.firmId)),
        lte(notices.startsAt, now),
        or(isNull(notices.endsAt), gt(notices.endsAt, now)),
      ),
    )
    .orderBy(notices.startsAt)
    .limit(20);
}

async function createOnce(
  db: DB,
  v: { firmId: string; title: string; body: string; startsAt: Date; endsAt: Date; dedupeKey: string },
): Promise<boolean> {
  const rows = await db
    .insert(notices)
    .values({ id: uuidv7(), kind: "billing", audience: "admins", ...v })
    .onConflictDoNothing()
    .returning({ id: notices.id });
  return rows.length === 1;
}

const DAY = 86_400_000;
const istDay = (d: Date) => new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const at = (day: string) => new Date(`${day}T00:00:00+05:30`);

/**
 * Billing notices for firm admins (BILLING §5): issued, due in 7 days, due today,
 * overdue. Called after issuing and by the daily cron; each stage is created once.
 */
export async function billingNotices(deps: NoticeDeps): Promise<number> {
  const today = istDay(deps.now());
  const open = await deps.db
    .select({
      id: invoices.id,
      firmId: invoices.firmId,
      number: invoices.number,
      dueOn: invoices.dueOn,
      total: invoices.totalPaise,
      issuedOn: invoices.issuedOn,
    })
    .from(invoices)
    .where(inArray(invoices.status, ["issued"]));
  let created = 0;
  for (const i of open) {
    if (!i.dueOn || !i.number) continue;
    const due = formatDate(at(i.dueOn));
    const amount = formatINR(i.total);
    const daysToDue = Math.round((at(i.dueOn).getTime() - at(today).getTime()) / DAY);
    const stages: { key: string; when: boolean; title: string; body: string; ends: Date }[] = [
      {
        key: "issued",
        when: true,
        title: `Invoice ${i.number} issued`,
        body: `Your Off Manual invoice ${i.number} for ${amount} is due on ${due}.`,
        ends: new Date(at(i.dueOn).getTime() + DAY),
      },
      {
        key: "due7",
        when: daysToDue <= 7 && daysToDue > 0,
        title: `Invoice ${i.number} due on ${due}`,
        body: `${amount} is due in ${daysToDue} day${daysToDue === 1 ? "" : "s"}.`,
        ends: new Date(at(i.dueOn).getTime() + DAY),
      },
      {
        key: "due0",
        when: daysToDue === 0,
        title: `Invoice ${i.number} is due today`,
        body: `${amount} is due today.`,
        ends: new Date(at(i.dueOn).getTime() + DAY),
      },
      {
        key: "overdue",
        when: daysToDue < 0,
        title: `Invoice ${i.number} is overdue`,
        body: `${amount} was due on ${due}. Please pay to keep Off Manual running without interruption.`,
        ends: new Date(at(today).getTime() + 60 * DAY),
      },
    ];
    for (const st of stages) {
      if (!st.when) continue;
      if (
        await createOnce(deps.db, {
          firmId: i.firmId,
          title: st.title,
          body: st.body,
          startsAt: deps.now(),
          endsAt: st.ends,
          dedupeKey: `invoice-${i.id}-${st.key}`,
        })
      ) {
        created++;
      }
    }
  }
  // A paid invoice's notices end now.
  await deps.db
    .update(notices)
    .set({ endsAt: deps.now() })
    .where(
      and(
        sql`${notices.dedupeKey} like 'invoice-%'`,
        or(isNull(notices.endsAt), gt(notices.endsAt, deps.now())),
        sql`exists (select 1 from ${invoices} where ${invoices.status} = 'paid' and ${notices.dedupeKey} like 'invoice-' || ${invoices.id} || '-%')`,
      ),
    );
  return created;
}

/** Staff/firm-admin list of a firm's notices (newest first). */
export async function listNotices(deps: NoticeDeps, s: SessionState | null, firmId: string) {
  requireFirmAccess(s, firmId);
  const firm = (await deps.db.select({ id: firms.id }).from(firms).where(eq(firms.id, firmId)))[0];
  if (!firm) throw new InputError("That firm doesn't exist.");
  return activeNotices(deps.db, firmId, deps.now());
}
