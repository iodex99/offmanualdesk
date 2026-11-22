// Email to a firm's admins (ADR-053): copies of billing notices (BILLING §5) and the
// weekly partner digest (M10). Counts and amounts only, never client data (rule 10).
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { formatDate, formatINR } from "@offmanual/shared-schema/format";
import {
  digestRuns,
  employees,
  firmAdmins,
  firms,
  invoices,
  notices,
  servers,
  usageDaily,
} from "@/db/schema";
import type { DB } from "./db";
import type { Mailer } from "./email";

export interface MailDeps {
  db: DB;
  now: () => Date;
  mailer?: Mailer | null;
}

async function adminEmails(db: DB, firmId: string): Promise<string[]> {
  return (
    await db
      .select({ email: firmAdmins.email })
      .from(firmAdmins)
      .where(and(eq(firmAdmins.firmId, firmId), isNull(firmAdmins.disabledAt)))
  ).map((r) => r.email);
}

/**
 * Emails every billing notice created since `since` to the firm's admins. The
 * notice's dedupe key is the idempotency key, so a retry never sends twice.
 */
export async function emailBillingNotices(deps: MailDeps, since: Date): Promise<number> {
  if (!deps.mailer) return 0;
  const fresh = await deps.db
    .select()
    .from(notices)
    .where(
      and(eq(notices.kind, "billing"), gte(notices.createdAt, since), sql`${notices.firmId} is not null`),
    );
  let sent = 0;
  for (const n of fresh) {
    for (const to of await adminEmails(deps.db, n.firmId!)) {
      try {
        await deps.mailer.send({
          to,
          subject: n.title,
          text: `${n.body}\n\nYou can see your invoices in the Off Manual console.\n\nOff Manual`,
          idempotencyKey: `${n.dedupeKey ?? n.id}-${to}`,
        });
        sent++;
      } catch {
        // One failed address doesn't stop the others; the notice is still in Desk.
      }
    }
  }
  return sent;
}

const DAY = 86_400_000;
const istDate = (d: Date) => new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

/** Monday (IST) of the week before `now`, and that week's Sunday. */
export function lastWeek(now: Date): { start: string; end: string } {
  const today = new Date(`${istDate(now)}T00:00:00Z`);
  const dow = (today.getUTCDay() + 6) % 7; // Monday = 0
  const thisMonday = new Date(today.getTime() - dow * DAY);
  const start = new Date(thisMonday.getTime() - 7 * DAY);
  return {
    start: start.toISOString().slice(0, 10),
    end: new Date(thisMonday.getTime() - DAY).toISOString().slice(0, 10),
  };
}

export interface DigestFacts {
  firm: string;
  weekStart: string;
  weekEnd: string;
  activeEmployees: number;
  totalEmployees: number;
  turns: number;
  serversHealthy: number;
  serversTotal: number;
  openInvoices: { number: string; totalPaise: bigint; dueOn: string }[];
}

export function digestText(f: DigestFacts): { subject: string; text: string } {
  const lines = [
    `Off Manual for ${f.firm}: week of ${formatDate(new Date(`${f.weekStart}T00:00:00+05:30`))} to ${formatDate(new Date(`${f.weekEnd}T00:00:00+05:30`))}`,
    "",
    `People using Off Manual: ${f.activeEmployees} of ${f.totalEmployees}`,
    `Questions and tasks handled: ${f.turns}`,
    `Servers healthy: ${f.serversHealthy} of ${f.serversTotal}`,
  ];
  if (f.openInvoices.length > 0) {
    lines.push("", "Invoices to pay:");
    for (const i of f.openInvoices) {
      lines.push(
        `- ${i.number}: ${formatINR(i.totalPaise)} due on ${formatDate(new Date(`${i.dueOn}T00:00:00+05:30`))}`,
      );
    }
  }
  lines.push("", "Off Manual");
  return { subject: `Off Manual weekly summary for ${f.firm}`, text: lines.join("\n") };
}

/** Builds the digest facts for one firm (counts only). */
export async function digestFacts(
  db: DB,
  firmId: string,
  week: { start: string; end: string },
): Promise<DigestFacts> {
  const firm = (await db.select({ name: firms.name }).from(firms).where(eq(firms.id, firmId)))[0]!;
  const usage = await db
    .select({ employeeId: usageDaily.employeeId, turns: usageDaily.turns })
    .from(usageDaily)
    .where(
      and(eq(usageDaily.firmId, firmId), gte(usageDaily.date, week.start), lte(usageDaily.date, week.end)),
    );
  const active = new Set(usage.filter((u) => u.turns > 0).map((u) => u.employeeId));
  const total = (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(employees)
      .where(and(eq(employees.firmId, firmId), eq(employees.status, "active")))
  )[0]!.n;
  const srv = await db.select({ health: servers.health }).from(servers).where(eq(servers.firmId, firmId));
  const open = await db
    .select({ number: invoices.number, totalPaise: invoices.totalPaise, dueOn: invoices.dueOn })
    .from(invoices)
    .where(and(eq(invoices.firmId, firmId), inArray(invoices.status, ["issued"])));
  return {
    firm: firm.name,
    weekStart: week.start,
    weekEnd: week.end,
    activeEmployees: active.size,
    totalEmployees: total,
    turns: usage.reduce((s, u) => s + u.turns, 0),
    serversHealthy: srv.filter((s) => s.health === "green").length,
    serversTotal: srv.length,
    openInvoices: open
      .filter((i): i is { number: string; totalPaise: bigint; dueOn: string } => Boolean(i.number && i.dueOn))
      .map((i) => ({ number: i.number, totalPaise: i.totalPaise, dueOn: i.dueOn })),
  };
}

/** Sends last week's digest to each active firm's admins, once per firm and week. */
export async function weeklyDigests(deps: MailDeps): Promise<number> {
  if (!deps.mailer) return 0;
  const week = lastWeek(deps.now());
  const active = await deps.db
    .select({ id: firms.id })
    .from(firms)
    .where(inArray(firms.status, ["trial", "active", "overdue", "restricted"]));
  let sent = 0;
  for (const f of active) {
    const to = await adminEmails(deps.db, f.id);
    if (to.length === 0) continue;
    // Claim the week first so two cron runs can't both send.
    const claimed = await deps.db
      .insert(digestRuns)
      .values({ firmId: f.id, weekStart: week.start, sentAt: deps.now() })
      .onConflictDoNothing()
      .returning({ firmId: digestRuns.firmId });
    if (claimed.length === 0) continue;
    const { subject, text } = digestText(await digestFacts(deps.db, f.id, week));
    for (const addr of to) {
      try {
        await deps.mailer.send({
          to: addr,
          subject,
          text,
          idempotencyKey: `digest-${f.id}-${week.start}-${addr}`,
        });
        sent++;
      } catch {
        // Next week's digest still goes; this one is not retried.
      }
    }
  }
  return sent;
}
