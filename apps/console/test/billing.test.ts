import { describe, expect, it } from "vitest";
import {
  computeInvoice,
  gst,
  monthBounds,
  seatAmount,
  seatQuantity,
  type Contract,
  type SeatDay,
} from "@/lib/billing/engine";
import { capabilities, ladderState, offlineLicenceValid } from "@/lib/billing/ladder";
import { amountInWords, applyBp, divRound, numberToIndianWords, percentToBp } from "@/lib/billing/money";

const NOV = monthBounds(2026, 11); // 30 days
const days = (
  emp: string,
  from: number,
  to: number,
  opts: { enabled?: boolean; active?: boolean } = {},
): SeatDay[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    employeeId: emp,
    date: `2026-11-${String(from + i).padStart(2, "0")}`,
    enabled: opts.enabled ?? true,
    active: opts.active ?? true,
  }));

const MH = { firmStateCode: "27", offManualStateCode: "27", gstRatePct: "18" };

describe("money", () => {
  it("rounds half away from zero, never floats", () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(1n, 3n)).toBe(0n);
    expect(divRound(2n, 3n)).toBe(1n);
    expect(() => divRound(1n, 0n)).toThrow();
  });
  it("percentages in basis points", () => {
    expect(percentToBp("18")).toBe(1800n);
    expect(percentToBp("12.5")).toBe(1250n);
    expect(percentToBp("-10")).toBe(-1000n);
    expect(applyBp(100000n, 900n)).toBe(9000n);
    expect(() => percentToBp("abc")).toThrow();
    expect(() => percentToBp("1.234")).toThrow();
  });
  it("Indian number words", () => {
    expect(numberToIndianWords(12345678n)).toBe(
      "One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight",
    );
    expect(numberToIndianWords(100000n)).toBe("One Lakh");
    expect(numberToIndianWords(1000000000n)).toBe("One Hundred Crore");
    expect(numberToIndianWords(0n)).toBe("Zero");
    expect(amountInWords(12345678n)).toBe(
      "Rupees One Lakh Twenty-Three Thousand Four Hundred Fifty-Six and Seventy-Eight Paise Only",
    );
    expect(amountInWords(1770000n)).toBe("Rupees Seventeen Thousand Seven Hundred Only");
    expect(() => amountInWords(-1n)).toThrow();
  });
});

describe("seats (ADR-014)", () => {
  it("prorated: Σ enabled days ÷ days in month", () => {
    const q = seatQuantity(
      "prorated_enabled_days",
      [...days("a", 1, 30), ...days("b", 16, 30), ...days("c", 1, 30, { enabled: false })],
      NOV,
    );
    expect(q).toEqual({ num: 45n, den: 30n }); // 1.5 seats
    expect(seatAmount(q, { ratePaise: 50000n }, "volume")).toBe(75000n);
  });
  it("peak active: highest number active on any day", () => {
    const q = seatQuantity(
      "peak_active",
      [...days("a", 1, 2), ...days("b", 2, 2), ...days("c", 2, 3), ...days("d", 3, 3, { active: false })],
      NOV,
    );
    expect(q).toEqual({ num: 3n, den: 1n });
  });
  it("ignores days outside the period", () => {
    const q = seatQuantity(
      "prorated_enabled_days",
      [{ employeeId: "a", date: "2026-10-31", enabled: true, active: true }],
      NOV,
    );
    expect(q.num).toBe(0n);
  });
  const bands = [
    { from: 1, to: 10, ratePaise: 50000n },
    { from: 11, to: null, ratePaise: 40000n },
  ];
  it("tiered bands charge each tier", () => {
    expect(seatAmount({ num: 360n, den: 30n }, { bands }, "tiered")).toBe(580000n); // 10×500 + 2×400
    expect(seatAmount({ num: 315n, den: 30n }, { bands }, "tiered")).toBe(520000n); // 10×500 + 0.5×400
  });
  it("volume bands use one rate for all seats", () => {
    expect(seatAmount({ num: 360n, den: 30n }, { bands }, "volume")).toBe(480000n); // 12×400
    expect(seatAmount({ num: 300n, den: 30n }, { bands }, "volume")).toBe(500000n); // 10×500
  });
  it("needs a rate or bands", () => {
    expect(() => seatAmount({ num: 1n, den: 1n }, {}, "volume")).toThrow();
  });
});

describe("computeInvoice", () => {
  const base: Contract = { seatCountMode: "prorated_enabled_days", bandsMode: "volume", lines: [] };

  it("bills setup once, AMC monthly with mid-month proration, seats, and GST same-state", () => {
    const contract: Contract = {
      ...base,
      lines: [
        {
          id: "setup",
          type: "one_time",
          label: "Setup",
          sac: "998313",
          amountPaise: 2500000n,
          startsOn: "2026-11-10",
          alreadyBilled: false,
        },
        {
          id: "amc",
          type: "recurring_flat",
          label: "AMC",
          sac: "998713",
          amountPaise: 300000n,
          interval: "month",
          startsOn: "2026-11-16",
        },
        {
          id: "seat",
          type: "per_seat",
          label: "Seats",
          sac: "998313",
          ratePaise: 50000n,
          startsOn: "2026-11-01",
        },
      ],
    };
    const inv = computeInvoice({
      contract,
      year: 2026,
      month: 11,
      seatDays: [...days("a", 1, 30), ...days("b", 16, 30)],
      usageTokens: 0n,
      ...MH,
    });
    expect(inv.lines.map((l) => [l.lineId, l.amountPaise, l.quantity])).toEqual([
      ["setup", 2500000n, "1"],
      ["amc", 150000n, "1"], // 15 of 30 days
      ["seat", 75000n, "1.50 seats"],
    ]);
    expect(inv.taxablePaise).toBe(2725000n);
    expect(inv.cgstPaise).toBe(245250n);
    expect(inv.sgstPaise).toBe(245250n);
    expect(inv.igstPaise).toBe(0n);
    expect(inv.totalPaise).toBe(3215500n);
    // Next month: no setup (already billed), full AMC.
    const dec = computeInvoice({
      contract: {
        ...contract,
        lines: contract.lines.map((l) => (l.type === "one_time" ? { ...l, alreadyBilled: true } : l)),
      },
      year: 2026,
      month: 12,
      seatDays: [],
      usageTokens: 0n,
      ...MH,
    });
    expect(dec.lines.map((l) => [l.lineId, l.amountPaise])).toEqual([["amc", 300000n]]);
  });

  it("quarterly and yearly lines bill only at the start of their interval", () => {
    const contract: Contract = {
      ...base,
      lines: [
        {
          id: "q",
          type: "recurring_flat",
          label: "Quarterly",
          sac: "x",
          amountPaise: 900000n,
          interval: "quarter",
          startsOn: "2026-11-01",
        },
        {
          id: "y",
          type: "recurring_flat",
          label: "Yearly",
          sac: "x",
          amountPaise: 3600000n,
          interval: "year",
          startsOn: "2026-11-01",
        },
      ],
    };
    const billed = (y: number, m: number) =>
      computeInvoice({ contract, year: y, month: m, seatDays: [], usageTokens: 0n, ...MH }).lines.map(
        (l) => l.lineId,
      );
    expect(billed(2026, 11)).toEqual(["q", "y"]);
    expect(billed(2026, 12)).toEqual([]);
    expect(billed(2027, 1)).toEqual([]);
    expect(billed(2027, 2)).toEqual(["q"]);
    expect(billed(2027, 11)).toEqual(["q", "y"]);
    expect(billed(2026, 10)).toEqual([]);
  });

  it("usage only above the included quota, with markup", () => {
    const contract: Contract = {
      ...base,
      lines: [
        {
          id: "u",
          type: "usage",
          label: "AI usage",
          sac: "x",
          ratePer1MTokensPaise: 10000n,
          includedTokens: 1_000_000n,
          markupPct: "20",
          startsOn: "2026-11-01",
        },
      ],
    };
    const inv = computeInvoice({
      contract,
      year: 2026,
      month: 11,
      seatDays: [],
      usageTokens: 3_000_000n,
      ...MH,
    });
    expect(inv.lines[0]).toMatchObject({ amountPaise: 24000n, quantity: "2000000 tokens" }); // 2M × ₹100/M = ₹200 + 20%
    const under = computeInvoice({
      contract,
      year: 2026,
      month: 11,
      seatDays: [],
      usageTokens: 900_000n,
      ...MH,
    });
    expect(under.lines).toEqual([]);
  });

  it("adjustments: percentage of the other lines, fixed credits, never below zero", () => {
    const contract: Contract = {
      ...base,
      lines: [
        {
          id: "amc",
          type: "recurring_flat",
          label: "AMC",
          sac: "x",
          amountPaise: 100000n,
          interval: "month",
          startsOn: "2026-01-01",
        },
        {
          id: "disc",
          type: "adjustment",
          label: "Pilot discount 10%",
          sac: "x",
          pct: "-10",
          startsOn: "2026-11-01",
          endsOn: "2026-11-30",
        },
        {
          id: "credit",
          type: "adjustment",
          label: "Credit",
          sac: "x",
          amountPaise: -5000n,
          startsOn: "2026-11-01",
        },
      ],
    };
    const inv = computeInvoice({ contract, year: 2026, month: 11, seatDays: [], usageTokens: 0n, ...MH });
    expect(inv.lines.map((l) => [l.lineId, l.amountPaise])).toEqual([
      ["amc", 100000n],
      ["disc", -10000n],
      ["credit", -5000n],
    ]);
    expect(inv.taxablePaise).toBe(85000n);
    const dec = computeInvoice({ contract, year: 2026, month: 12, seatDays: [], usageTokens: 0n, ...MH });
    expect(dec.lines.map((l) => l.lineId)).toEqual(["amc", "credit"]); // discount ended
    const big = computeInvoice({
      contract: {
        ...contract,
        lines: [
          {
            id: "c",
            type: "adjustment",
            label: "Waiver",
            sac: "x",
            amountPaise: -999999n,
            startsOn: "2026-11-01",
          },
        ],
      },
      year: 2026,
      month: 11,
      seatDays: [],
      usageTokens: 0n,
      ...MH,
    });
    expect(big.taxablePaise).toBe(0n);
    expect(big.totalPaise).toBe(0n);
  });

  it("per-seat line versions split by contract dates", () => {
    const contract: Contract = {
      ...base,
      lines: [
        {
          id: "v1",
          type: "per_seat",
          label: "Seats (old rate)",
          sac: "x",
          ratePaise: 60000n,
          startsOn: "2026-01-01",
          endsOn: "2026-11-15",
        },
        {
          id: "v2",
          type: "per_seat",
          label: "Seats (new rate)",
          sac: "x",
          ratePaise: 30000n,
          startsOn: "2026-11-16",
        },
      ],
    };
    const inv = computeInvoice({
      contract,
      year: 2026,
      month: 11,
      seatDays: days("a", 1, 30),
      usageTokens: 0n,
      ...MH,
    });
    expect(inv.lines.map((l) => [l.lineId, l.amountPaise])).toEqual([
      ["v1", 30000n],
      ["v2", 15000n],
    ]);
  });
});

describe("GST (BILLING §2)", () => {
  it("same state: CGST + SGST; other state: IGST", () => {
    expect(gst(100000n, MH)).toEqual({
      taxablePaise: 100000n,
      cgstPaise: 9000n,
      sgstPaise: 9000n,
      igstPaise: 0n,
      totalPaise: 118000n,
    });
    expect(gst(100000n, { ...MH, firmStateCode: "24" })).toEqual({
      taxablePaise: 100000n,
      cgstPaise: 0n,
      sgstPaise: 0n,
      igstPaise: 18000n,
      totalPaise: 118000n,
    });
  });
  it("rounds each tax to the paisa", () => {
    expect(gst(55n, MH)).toMatchObject({ cgstPaise: 5n, sgstPaise: 5n, totalPaise: 65n }); // 4.95 → 5
    expect(gst(55n, { ...MH, firmStateCode: "29" })).toMatchObject({ igstPaise: 10n }); // 9.9 → 10
  });
});

describe("enforcement ladder (BILLING §6)", () => {
  const policy = { graceDays: 7, suspendAfterDays: 30 };
  const unpaid = [{ dueOn: "2026-11-01", paid: false }];
  it("moves active → overdue → restricted → suspended by days past due", () => {
    expect(ladderState(unpaid, "2026-11-01", policy).state).toBe("active");
    expect(ladderState(unpaid, "2026-11-02", policy)).toEqual({
      state: "overdue",
      daysOverdue: 1,
      source: "computed",
    });
    expect(ladderState(unpaid, "2026-11-08", policy).state).toBe("overdue");
    expect(ladderState(unpaid, "2026-11-09", policy).state).toBe("restricted");
    expect(ladderState(unpaid, "2026-12-01", policy).state).toBe("restricted");
    expect(ladderState(unpaid, "2026-12-02", policy).state).toBe("suspended");
    expect(ladderState([{ dueOn: "2026-11-01", paid: true }], "2026-12-30", policy).state).toBe("active");
  });
  it("uses the oldest unpaid invoice", () => {
    expect(
      ladderState(
        [
          { dueOn: "2026-10-01", paid: false },
          { dueOn: "2026-11-20", paid: false },
        ],
        "2026-11-21",
        policy,
      ).state,
    ).toBe("suspended");
  });
  it("manual override wins while valid and needs a reason", () => {
    expect(
      ladderState(unpaid, "2026-12-30", policy, {
        state: "active",
        reason: "Cheque received",
        until: "2026-12-31",
      }),
    ).toMatchObject({ state: "active", source: "override" });
    expect(
      ladderState(unpaid, "2027-01-01", policy, { state: "active", reason: "x", until: "2026-12-31" }).source,
    ).toBe("computed");
    expect(() => ladderState(unpaid, "2026-11-05", policy, { state: "active", reason: "  " })).toThrow(
      /reason/,
    );
  });
  it("capabilities per state", () => {
    expect(capabilities("overdue")).toEqual({ banner: true, newSeatsAndPacks: true, employeesCanUse: true });
    expect(capabilities("restricted")).toEqual({
      banner: true,
      newSeatsAndPacks: false,
      employeesCanUse: true,
    });
    expect(capabilities("suspended").employeesCanUse).toBe(false);
    expect(capabilities("active").banner).toBe(false);
  });
  it("offline grace keeps the licence working for 7 days", () => {
    const now = new Date("2026-11-22T00:00:00Z");
    expect(offlineLicenceValid(new Date("2026-11-16T00:00:00Z"), now)).toBe(true);
    expect(offlineLicenceValid(new Date("2026-11-14T00:00:00Z"), now)).toBe(false);
    expect(offlineLicenceValid(null, now)).toBe(false);
  });
});
