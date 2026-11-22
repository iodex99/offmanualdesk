import { describe, expect, it } from "vitest";
import { formatDate, formatINR, fyLabel, groupIndian, invoiceNumber } from "../src/format.js";

describe("groupIndian", () => {
  it.each([
    ["0", "0"],
    ["7", "7"],
    ["999", "999"],
    ["1000", "1,000"],
    ["12345", "12,345"],
    ["123456", "1,23,456"],
    ["1234567", "12,34,567"],
    ["123456789", "12,34,56,789"],
    ["000123456", "1,23,456"],
  ])("%s → %s", (input, want) => {
    expect(groupIndian(input)).toBe(want);
  });
  it("rejects non-digits", () => {
    expect(() => groupIndian("12a")).toThrow();
    expect(() => groupIndian("-1")).toThrow();
  });
});

describe("formatINR", () => {
  it("formats paise with Indian grouping", () => {
    expect(formatINR(12345678n)).toBe("₹1,23,456.78");
    expect(formatINR(0)).toBe("₹0.00");
    expect(formatINR(5)).toBe("₹0.05");
    expect(formatINR(174500)).toBe("₹1,745.00");
    expect(formatINR(-250050)).toBe("-₹2,500.50");
    expect(formatINR(10000000000n, { showPaise: false })).toBe("₹10,00,00,000");
  });
  it("handles amounts beyond Number.MAX_SAFE_INTEGER exactly", () => {
    expect(formatINR(123456789012345678901n)).toBe("₹12,34,56,78,90,12,34,56,789.01");
  });
  it("rejects fractional numbers (money is integer paise)", () => {
    expect(() => formatINR(1.5)).toThrow();
  });
});

describe("formatDate (IST, DD-MM-YYYY)", () => {
  it("uses IST, not the machine time zone", () => {
    // 20:00 UTC on 31 March is 01:30 IST on 1 April.
    expect(formatDate(new Date("2026-03-31T20:00:00Z"))).toBe("01-04-2026");
    expect(formatDate(new Date("2026-11-22T00:00:00Z"))).toBe("22-11-2026");
  });
  it("rejects invalid dates", () => {
    expect(() => formatDate(new Date("nope"))).toThrow();
  });
});

describe("fyLabel", () => {
  it.each([
    ["2026-03-31T12:00:00Z", "FY2025-26"],
    ["2026-04-01T00:00:00+05:30", "FY2026-27"],
    ["2026-03-31T18:29:59Z", "FY2025-26"], // 23:59:59 IST on 31 March
    ["2026-03-31T18:30:00Z", "FY2026-27"], // 00:00 IST on 1 April
    ["2099-06-01T00:00:00Z", "FY2099-00"],
  ])("%s → %s", (iso, want) => {
    expect(fyLabel(new Date(iso))).toBe(want);
  });
});

describe("invoiceNumber", () => {
  it("numbers per FY", () => {
    expect(invoiceNumber(new Date("2026-11-22T00:00:00Z"), 1)).toBe("OM/FY2026-27/0001");
    expect(invoiceNumber(new Date("2027-01-05T00:00:00Z"), 42)).toBe("OM/FY2026-27/0042");
  });
  it("rejects out-of-range sequences", () => {
    expect(() => invoiceNumber(new Date(), 0)).toThrow();
    expect(() => invoiceNumber(new Date(), 10000)).toThrow();
    expect(() => invoiceNumber(new Date(), 1.5)).toThrow();
  });
});
