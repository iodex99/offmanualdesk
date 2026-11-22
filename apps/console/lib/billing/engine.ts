// Invoice computation (docs/BILLING.md §1–§3). Pure: contracts, seat days and usage
// in; invoice lines and GST out. Every rule here is covered by test/billing.test.ts.
//
// Dates are calendar days "YYYY-MM-DD" (IST business dates). Periods are one month.
import { applyBp, divRound, percentToBp } from "./money";

export type SeatCountMode = "prorated_enabled_days" | "peak_active";
export type BandsMode = "tiered" | "volume";
export type Interval = "month" | "quarter" | "year";

export interface Band {
  from: number; // first seat number in the band (1-based)
  to: number | null; // last seat number, null = no upper limit
  ratePaise: bigint;
}

export type ContractLine =
  | {
      id: string;
      type: "one_time";
      label: string;
      sac: string;
      amountPaise: bigint;
      startsOn: string;
      alreadyBilled: boolean;
    }
  | {
      id: string;
      type: "recurring_flat";
      label: string;
      sac: string;
      amountPaise: bigint;
      interval: Interval;
      startsOn: string;
      endsOn?: string;
    }
  | {
      id: string;
      type: "per_seat";
      label: string;
      sac: string;
      ratePaise?: bigint;
      bands?: Band[];
      startsOn: string;
      endsOn?: string;
    }
  | {
      id: string;
      type: "usage";
      label: string;
      sac: string;
      ratePer1MTokensPaise: bigint;
      includedTokens: bigint;
      markupPct: string;
      startsOn: string;
      endsOn?: string;
    }
  | {
      id: string;
      type: "adjustment";
      label: string;
      sac: string;
      pct?: string; // e.g. "-10" for a 10% discount on the other lines this period
      amountPaise?: bigint; // e.g. -500000n for a ₹5,000 credit
      startsOn: string;
      endsOn?: string;
    };

export interface Contract {
  seatCountMode: SeatCountMode;
  bandsMode: BandsMode;
  lines: ContractLine[];
}

export interface SeatDay {
  employeeId: string;
  date: string;
  enabled: boolean;
  active: boolean;
}

export interface InvoiceLine {
  lineId: string;
  description: string;
  sac: string;
  quantity: string; // human-readable (e.g. "12.45 seats", "1")
  amountPaise: bigint;
}

export interface Invoice {
  periodStart: string;
  periodEnd: string;
  lines: InvoiceLine[];
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  totalPaise: bigint;
}

// ---- dates ----

const parse = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`bad date ${d}`);
  return new Date(`${d}T00:00:00Z`);
};
const fmt = (d: Date) => d.toISOString().slice(0, 10);

export function monthBounds(year: number, month: number): { start: string; end: string; days: number } {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return { start: fmt(start), end: fmt(end), days: end.getUTCDate() };
}

function overlapDays(aStart: string, aEnd: string, bStart: string, bEnd?: string): number {
  const s = Math.max(parse(aStart).getTime(), parse(bStart).getTime());
  const e = Math.min(parse(aEnd).getTime(), bEnd ? parse(bEnd).getTime() : Number.MAX_SAFE_INTEGER);
  return e < s ? 0 : Math.round((e - s) / 86400000) + 1;
}

// ---- seats ----

/** Seat quantity as an exact fraction num/den (BILLING §1, ADR-014). */
export function seatQuantity(
  mode: SeatCountMode,
  days: SeatDay[],
  period: { start: string; end: string; days: number },
): { num: bigint; den: bigint } {
  const inPeriod = days.filter((d) => d.date >= period.start && d.date <= period.end);
  if (mode === "prorated_enabled_days") {
    // Σ over seats of (days enabled ÷ days in month).
    const enabledDays = inPeriod.filter((d) => d.enabled).length;
    return { num: BigInt(enabledDays), den: BigInt(period.days) };
  }
  const perDay = new Map<string, number>();
  for (const d of inPeriod) if (d.active) perDay.set(d.date, (perDay.get(d.date) ?? 0) + 1);
  return { num: BigInt(Math.max(0, ...perDay.values())), den: 1n };
}

/** Price for a fractional seat quantity q = num/den, in paise. */
export function seatAmount(
  q: { num: bigint; den: bigint },
  line: { ratePaise?: bigint; bands?: Band[] },
  mode: BandsMode,
): bigint {
  if (line.bands && line.bands.length > 0) {
    const bands = [...line.bands].sort((a, b) => a.from - b.from);
    if (mode === "volume") {
      // One rate for all seats, chosen by the (rounded-up) seat count.
      const count = Number((q.num + q.den - 1n) / q.den);
      const band =
        bands.find((b) => count >= b.from && (b.to === null || count <= b.to)) ?? bands[bands.length - 1]!;
      return divRound(q.num * band.ratePaise, q.den);
    }
    // Tiered: each band charges only the seats inside it.
    let total = 0n; // in paise × den
    for (const b of bands) {
      const lo = BigInt(b.from - 1) * q.den;
      const hi = b.to === null ? q.num : BigInt(b.to) * q.den;
      const units = (q.num < hi ? q.num : hi) - lo;
      if (units > 0n) total += units * b.ratePaise;
    }
    return divRound(total, q.den);
  }
  if (line.ratePaise === undefined) throw new Error("per_seat line needs a rate or bands");
  return divRound(q.num * line.ratePaise, q.den);
}

const seatsLabel = (q: { num: bigint; den: bigint }) => {
  const hundredths = divRound(q.num * 100n, q.den);
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, "0")} seats`;
};

// ---- recurring schedule ----

function intervalStartsInMonth(startsOn: string, interval: Interval, year: number, month: number): boolean {
  const s = parse(startsOn);
  const months = (year - s.getUTCFullYear()) * 12 + (month - 1 - s.getUTCMonth());
  if (months < 0) return false;
  return interval === "month" ? true : interval === "quarter" ? months % 3 === 0 : months % 12 === 0;
}

// ---- the invoice ----

export interface InvoiceInput {
  contract: Contract;
  year: number;
  month: number;
  seatDays: SeatDay[];
  /** Tokens on Off Manual's key this month; 0 when the firm uses its own key (ADR-011). */
  usageTokens: bigint;
  firmStateCode: string;
  offManualStateCode: string;
  gstRatePct: string; // "18"
}

export function computeInvoice(input: InvoiceInput): Invoice {
  const period = monthBounds(input.year, input.month);
  const lines: InvoiceLine[] = [];
  const adjustments: Extract<ContractLine, { type: "adjustment" }>[] = [];

  for (const l of input.contract.lines) {
    switch (l.type) {
      case "one_time":
        if (!l.alreadyBilled && l.startsOn <= period.end) {
          lines.push({
            lineId: l.id,
            description: l.label,
            sac: l.sac,
            quantity: "1",
            amountPaise: l.amountPaise,
          });
        }
        break;
      case "recurring_flat": {
        if (!intervalStartsInMonth(l.startsOn, l.interval, input.year, input.month)) break;
        if (l.endsOn && l.endsOn < period.start) break;
        let amount = l.amountPaise;
        if (l.interval === "month") {
          // Mid-month start or end: prorate by days covered (BILLING §3).
          const covered = overlapDays(period.start, period.end, l.startsOn, l.endsOn);
          amount = divRound(l.amountPaise * BigInt(covered), BigInt(period.days));
        }
        if (amount !== 0n)
          lines.push({ lineId: l.id, description: l.label, sac: l.sac, quantity: "1", amountPaise: amount });
        break;
      }
      case "per_seat": {
        // Seat days outside this line's validity don't count (contract version changes).
        const days = input.seatDays.filter((d) => d.date >= l.startsOn && (!l.endsOn || d.date <= l.endsOn));
        const q = seatQuantity(input.contract.seatCountMode, days, period);
        if (q.num === 0n) break;
        const amount = seatAmount(q, l, input.contract.bandsMode);
        lines.push({
          lineId: l.id,
          description: l.label,
          sac: l.sac,
          quantity: seatsLabel(q),
          amountPaise: amount,
        });
        break;
      }
      case "usage": {
        if (l.startsOn > period.end || (l.endsOn && l.endsOn < period.start)) break;
        const billable = input.usageTokens > l.includedTokens ? input.usageTokens - l.includedTokens : 0n;
        if (billable === 0n) break;
        const base = divRound(billable * l.ratePer1MTokensPaise, 1_000_000n);
        const amount = base + applyBp(base, percentToBp(l.markupPct));
        lines.push({
          lineId: l.id,
          description: l.label,
          sac: l.sac,
          quantity: `${billable} tokens`,
          amountPaise: amount,
        });
        break;
      }
      case "adjustment":
        if (l.startsOn <= period.end && (!l.endsOn || l.endsOn >= period.start)) adjustments.push(l);
        break;
    }
  }

  // Adjustments apply after the other lines: percentage of their sum, or a fixed amount.
  const base = lines.reduce((s, l) => s + l.amountPaise, 0n);
  for (const a of adjustments) {
    const amount = a.pct !== undefined ? applyBp(base, percentToBp(a.pct)) : (a.amountPaise ?? 0n);
    if (amount !== 0n)
      lines.push({ lineId: a.id, description: a.label, sac: a.sac, quantity: "1", amountPaise: amount });
  }

  let taxable = lines.reduce((s, l) => s + l.amountPaise, 0n);
  if (taxable < 0n) taxable = 0n; // credits never create a negative invoice; carry-forward is manual
  return { periodStart: period.start, periodEnd: period.end, lines, ...gst(taxable, input) };
}

/** GST split (BILLING §2): same state → CGST + SGST (half each); else IGST. */
export function gst(
  taxable: bigint,
  i: { firmStateCode: string; offManualStateCode: string; gstRatePct: string },
): Pick<Invoice, "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise" | "totalPaise"> {
  const bp = percentToBp(i.gstRatePct);
  if (i.firmStateCode === i.offManualStateCode) {
    const half = applyBp(taxable, bp / 2n);
    return {
      taxablePaise: taxable,
      cgstPaise: half,
      sgstPaise: half,
      igstPaise: 0n,
      totalPaise: taxable + 2n * half,
    };
  }
  const igst = applyBp(taxable, bp);
  return { taxablePaise: taxable, cgstPaise: 0n, sgstPaise: 0n, igstPaise: igst, totalPaise: taxable + igst };
}
