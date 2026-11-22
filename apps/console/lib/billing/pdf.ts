// Invoice PDF (BILLING §2): both GSTINs, place of supply, SAC per line, taxable
// value, tax split, total in words (Indian numbering). Built in two steps so the
// content is unit-tested: `invoiceLayout` (pure: positioned text) and
// `renderInvoicePdf` (pdf-lib 1.17.1, standard Helvetica).
//
// Standard PDF fonts only cover WinAnsi, so amounts use "Rs." instead of ₹ and any
// other character is replaced with "?" rather than failing the whole invoice.
import { PDFDocument, StandardFonts } from "pdf-lib";
import { formatDate, formatINR } from "@offmanual/shared-schema/format";
import { amountInWords } from "./money";

export interface InvoicePdfData {
  number: string | null; // null = draft
  issuedOn: string | null;
  dueOn: string | null;
  periodStart: string;
  periodEnd: string;
  seller: { legalName: string; address: string; gstin: string | null; stateCode: string };
  buyer: { legalName: string; gstin: string | null; stateCode: string };
  lines: { description: string; sac: string; quantity: string; amountPaise: bigint }[];
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  totalPaise: bigint;
  gstRatePct: string;
}

export interface TextLine {
  text: string;
  x: number;
  y: number;
  size: number;
  bold?: boolean;
  /** Right-align so the text ends at x. */
  right?: boolean;
}

/** Keeps printable Latin-1 (what WinAnsi standard fonts can draw). */
export function pdfSafe(s: string): string {
  return s.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

export const rs = (paise: bigint) => formatINR(paise, { showPaise: true }).replace("₹", "Rs. ");
const day = (d: string | null) => (d ? formatDate(new Date(`${d}T00:00:00+05:30`)) : "-");

const PAGE_W = 595.28; // A4 points
const PAGE_H = 841.89;
const LEFT = 50;
const RIGHT = PAGE_W - 50;

export function invoiceLayout(d: InvoicePdfData): TextLine[] {
  const out: TextLine[] = [];
  let y = PAGE_H - 60;
  const put = (text: string, x: number, size = 10, opts: Partial<TextLine> = {}) =>
    out.push({ text: pdfSafe(text), x, y, size, ...opts });
  const next = (h = 14) => {
    y -= h;
  };

  put(d.number ? "TAX INVOICE" : "DRAFT INVOICE (not valid for tax)", LEFT, 16, { bold: true });
  next(26);
  put(d.seller.legalName, LEFT, 11, { bold: true });
  put(d.number ? `Invoice no. ${d.number}` : "Invoice no. (on issue)", RIGHT, 10, { right: true });
  next();
  put(d.seller.address, LEFT);
  put(`Invoice date: ${day(d.issuedOn)}`, RIGHT, 10, { right: true });
  next();
  put(`GSTIN: ${d.seller.gstin ?? "-"}   State code: ${d.seller.stateCode}`, LEFT);
  put(`Due date: ${day(d.dueOn)}`, RIGHT, 10, { right: true });
  next(24);

  put("Bill to", LEFT, 10, { bold: true });
  next();
  put(d.buyer.legalName, LEFT);
  next();
  put(`GSTIN: ${d.buyer.gstin ?? "Unregistered"}   State code: ${d.buyer.stateCode}`, LEFT);
  next();
  put(`Place of supply: state code ${d.buyer.stateCode}`, LEFT);
  next();
  put(`Period: ${day(d.periodStart)} to ${day(d.periodEnd)}`, LEFT);
  next(24);

  put("Description", LEFT, 10, { bold: true });
  put("SAC", 330, 10, { bold: true });
  put("Quantity", 390, 10, { bold: true });
  put("Amount", RIGHT, 10, { bold: true, right: true });
  next(16);
  for (const l of d.lines) {
    put(l.description.slice(0, 55), LEFT);
    put(l.sac, 330);
    put(l.quantity.slice(0, 18), 390);
    put(rs(l.amountPaise), RIGHT, 10, { right: true });
    next();
  }
  next(10);
  const half = (Number(d.gstRatePct) / 2).toString();
  const row = (label: string, paise: bigint, bold = false) => {
    put(label, 330, 10, { bold });
    put(rs(paise), RIGHT, 10, { right: true, bold });
    next();
  };
  row("Taxable value", d.taxablePaise);
  if (
    d.igstPaise > 0n ||
    (d.cgstPaise === 0n && d.sgstPaise === 0n && d.seller.stateCode !== d.buyer.stateCode)
  ) {
    row(`IGST @ ${d.gstRatePct}%`, d.igstPaise);
  } else {
    row(`CGST @ ${half}%`, d.cgstPaise);
    row(`SGST @ ${half}%`, d.sgstPaise);
  }
  row("Total", d.totalPaise, true);
  next(8);
  put(`Amount in words: ${amountInWords(d.totalPaise)}`, LEFT, 10);
  next(30);
  put("This is a computer-generated invoice.", LEFT, 8);
  return out;
}

export async function renderInvoicePdf(d: InvoicePdfData, createdAt: Date): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(d.number ? `Invoice ${d.number}` : "Draft invoice"));
  doc.setProducer("Off Manual console");
  doc.setCreationDate(createdAt);
  doc.setModificationDate(createdAt);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  for (const t of invoiceLayout(d)) {
    const font = t.bold ? bold : regular;
    const x = t.right ? t.x - font.widthOfTextAtSize(t.text, t.size) : t.x;
    page.drawText(t.text, { x, y: t.y, size: t.size, font });
  }
  return doc.save();
}
