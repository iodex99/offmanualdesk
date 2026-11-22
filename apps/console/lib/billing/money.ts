// Money helpers (docs/BILLING.md). Amounts are integer paise as bigint; no floats.

/** Round numerator/denominator to the nearest paisa, halves away from zero. */
export function divRound(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error("denominator must be positive");
  const neg = num < 0n;
  const n = neg ? -num : num;
  const q = (2n * n + den) / (2n * den);
  return neg ? -q : q;
}

/** pct as a decimal string like "18" or "12.5" → basis points (1% = 100 bp). */
export function percentToBp(pct: string | number): bigint {
  const s = String(pct).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`invalid percentage ${s}`);
  const [i, f = ""] = s.replace("-", "").split(".");
  const bp = BigInt(i!) * 100n + BigInt((f + "00").slice(0, 2));
  return s.startsWith("-") ? -bp : bp;
}

/** amount × bp / 10000, rounded half away from zero. */
export function applyBp(amount: bigint, bp: bigint): bigint {
  return divRound(amount * bp, 10000n);
}

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function below100(n: number): string {
  if (n < 20) return ONES[n]!;
  const t = TENS[Math.floor(n / 10)]!;
  return n % 10 ? `${t}-${ONES[n % 10]}` : t;
}

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? below100(r) : ""].filter(Boolean).join(" ");
}

/** Indian numbering in words: 12345678 → "One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight". */
export function numberToIndianWords(n: bigint): string {
  if (n < 0n) throw new Error("negative");
  if (n === 0n) return "Zero";
  const parts: string[] = [];
  const crore = n / 10000000n;
  let rest = n % 10000000n;
  if (crore > 0n) parts.push(`${numberToIndianWords(crore)} Crore`);
  const lakh = Number(rest / 100000n);
  rest %= 100000n;
  const thousand = Number(rest / 1000n);
  const hundreds = Number(rest % 1000n);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (hundreds) parts.push(below1000(hundreds));
  return parts.join(" ");
}

/** "Rupees ... and ... Paise Only" for an invoice total (BILLING §2). */
export function amountInWords(paise: bigint): string {
  if (paise < 0n) throw new Error("negative amount");
  const rupees = paise / 100n;
  const p = Number(paise % 100n);
  const r = `Rupees ${numberToIndianWords(rupees)}`;
  return p ? `${r} and ${below100(p)} Paise Only` : `${r} Only`;
}
