import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { invoiceLayout, pdfSafe, renderInvoicePdf, rs, type InvoicePdfData } from "@/lib/billing/pdf";

const base: InvoicePdfData = {
  number: "OM/FY2026-27/0001",
  issuedOn: "2026-12-01",
  dueOn: "2026-12-16",
  periodStart: "2026-11-01",
  periodEnd: "2026-11-30",
  seller: {
    legalName: "Off Manual",
    address: "Mumbai, Maharashtra",
    gstin: "27AAAAA0000A1Z5",
    stateCode: "27",
  },
  buyer: { legalName: "Mehta and Co LLP", gstin: "27AAPFM1234C1Z5", stateCode: "27" },
  lines: [
    { description: "AMC", sac: "998313", quantity: "1", amountPaise: 200000n },
    { description: "Seats", sac: "998313", quantity: "1.50 seats", amountPaise: 225000n },
  ],
  taxablePaise: 425000n,
  cgstPaise: 38250n,
  sgstPaise: 38250n,
  igstPaise: 0n,
  totalPaise: 501500n,
  gstRatePct: "18",
};

const texts = (d: InvoicePdfData) => invoiceLayout(d).map((t) => t.text);

describe("invoice PDF", () => {
  it("has both GSTINs, place of supply, SAC, the CGST/SGST split, dates and the total in words", () => {
    const t = texts(base).join("\n");
    expect(t).toContain("TAX INVOICE");
    expect(t).toContain("Invoice no. OM/FY2026-27/0001");
    expect(t).toContain("GSTIN: 27AAAAA0000A1Z5");
    expect(t).toContain("GSTIN: 27AAPFM1234C1Z5");
    expect(t).toContain("Place of supply: state code 27");
    expect(t).toContain("Invoice date: 01-12-2026");
    expect(t).toContain("Due date: 16-12-2026");
    expect(t).toContain("998313");
    expect(t).toContain("CGST @ 9%");
    expect(t).toContain("SGST @ 9%");
    expect(t).not.toContain("IGST");
    expect(t).toContain(rs(501500n));
    expect(rs(501500n)).toBe("Rs. 5,015.00");
    expect(t).toMatch(/Amount in words: .*Five Thousand Fifteen/i);
  });

  it("IGST for another state; drafts say so; unregistered buyer", () => {
    const t = texts({
      ...base,
      number: null,
      issuedOn: null,
      dueOn: null,
      buyer: { legalName: "Shah", gstin: null, stateCode: "24" },
      cgstPaise: 0n,
      sgstPaise: 0n,
      igstPaise: 76500n,
    }).join("\n");
    expect(t).toContain("DRAFT INVOICE (not valid for tax)");
    expect(t).toContain("IGST @ 18%");
    expect(t).not.toContain("CGST");
    expect(t).toContain("GSTIN: Unregistered");
    expect(t).toContain("Invoice date: -");
  });

  it("never fails on characters the standard font can't draw", async () => {
    expect(pdfSafe("मेहता & Co ₹")).toBe("????? & Co ?");
    const bytes = await renderInvoicePdf(
      { ...base, buyer: { ...base.buyer, legalName: "मेहता & Co" } },
      new Date("2026-12-01T00:00:00Z"),
    );
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe("Invoice OM/FY2026-27/0001");
  });
});
