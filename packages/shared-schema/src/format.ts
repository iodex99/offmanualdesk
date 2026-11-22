// Browser-safe formatting helpers for PRODUCT.md §4 rule 8 (Indian conventions).
// No Node imports here: Desk's WebView and the console's client components use this.

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000; // India has no daylight saving.

/** Groups an unsigned integer string the Indian way: 1234567 → "12,34,567". */
export function groupIndian(digits: string): string {
  if (!/^\d+$/.test(digits)) throw new Error("groupIndian expects digits only");
  const trimmed = digits.replace(/^0+(?=\d)/, "");
  if (trimmed.length <= 3) return trimmed;
  const last3 = trimmed.slice(-3);
  let rest = trimmed.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return `${parts.join(",")},${last3}`;
}

/**
 * Formats an amount in paise as rupees: 12345678n → "₹1,23,456.78".
 * Money is stored as integer paise everywhere (console rules), so this never uses floats.
 */
export function formatINR(paise: bigint | number, opts: { showPaise?: boolean } = {}): string {
  if (typeof paise === "number" && !Number.isSafeInteger(paise)) {
    throw new Error("formatINR expects integer paise");
  }
  const value = BigInt(paise);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const rupees = groupIndian((abs / 100n).toString());
  const fraction = (abs % 100n).toString().padStart(2, "0");
  const showPaise = opts.showPaise ?? true;
  return `${negative ? "-" : ""}₹${rupees}${showPaise ? `.${fraction}` : ""}`;
}

function toIST(date: Date): Date {
  if (Number.isNaN(date.getTime())) throw new Error("invalid date");
  return new Date(date.getTime() + IST_OFFSET_MS);
}

/** DD-MM-YYYY in IST, whatever the machine's time zone. */
export function formatDate(date: Date): string {
  const d = toIST(date);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
}

/** Indian financial year label for a date (IST): 2026-03-31 → "FY2025-26", 2026-04-01 → "FY2026-27". */
export function fyLabel(date: Date): string {
  const d = toIST(date);
  const year = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? year : year - 1; // April = month 3
  return `FY${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Invoice number per FY (docs/BILLING.md §2): OM/FY2026-27/0001. */
export function invoiceNumber(date: Date, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 9999) {
    throw new Error("invoice sequence must be 1..9999");
  }
  return `OM/${fyLabel(date)}/${String(sequence).padStart(4, "0")}`;
}
