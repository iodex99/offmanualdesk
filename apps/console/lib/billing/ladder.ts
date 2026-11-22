// Enforcement ladder (docs/BILLING.md §6): active → overdue → restricted → suspended,
// driven by the oldest unpaid invoice past its due date. Manual override wins.
export type FirmBillingState = "active" | "overdue" | "restricted" | "suspended";

export interface LadderPolicy {
  graceDays: number; // overdue → restricted after this many days past due
  suspendAfterDays: number; // → suspended after this many days past due
}

export interface OpenInvoice {
  dueOn: string; // YYYY-MM-DD
  paid: boolean;
}

export interface Override {
  state: FirmBillingState;
  reason: string;
  until?: string;
}

const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86400000;

export function ladderState(
  invoices: OpenInvoice[],
  today: string,
  policy: LadderPolicy,
  override?: Override,
): { state: FirmBillingState; daysOverdue: number; source: "computed" | "override" } {
  if (override && (!override.until || override.until >= today)) {
    if (!override.reason.trim()) throw new Error("an override needs a reason");
    return { state: override.state, daysOverdue: 0, source: "override" };
  }
  const t = day(today);
  const overdueBy = invoices.filter((i) => !i.paid && day(i.dueOn) < t).map((i) => t - day(i.dueOn));
  const worst = overdueBy.length ? Math.max(...overdueBy) : 0;
  let state: FirmBillingState = "active";
  if (worst > 0) state = "overdue";
  if (worst > policy.graceDays) state = "restricted";
  if (worst > policy.suspendAfterDays) state = "suspended";
  return { state, daysOverdue: worst, source: "computed" };
}

/** What each state allows (BILLING §6). */
export function capabilities(state: FirmBillingState) {
  return {
    banner: state !== "active",
    newSeatsAndPacks: state === "active" || state === "overdue",
    employeesCanUse: state !== "suspended", // suspended: Desk opens for firm admins only; no data deleted
  };
}

/** Licence keeps working offline for the grace period before any ladder step (BILLING §6). */
export function offlineLicenceValid(
  lastConsoleContact: Date | null,
  now: Date,
  offlineGraceDays = 7,
): boolean {
  if (!lastConsoleContact) return false;
  return now.getTime() - lastConsoleContact.getTime() <= offlineGraceDays * 86400000;
}
