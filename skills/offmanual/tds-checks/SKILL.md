---
name: tds-checks
description: Check a client's TDS for a period from the books - section and rate sanity, PAN availability and format, deductions missed, late deduction or payment interest estimates - and save a findings sheet in the client's folder.
user-invocable: true
metadata: { "openclaw": { "os": ["win32"] } }
---

# TDS checks

Produces `TDS_Checks_<Client>_<Period>.xlsx` in the client's folder. It points out what to look at; it never
changes the books, never files returns and never pays.

## Inputs

- Client and period (month, quarter or financial year).
- Expense, party and TDS payable ledgers from Tally (tally-read skill) or exported ledgers in the folder.
- The firm's TDS rate table for the year: `TDS_Rates_<FY>.xlsx` in the firm's reference folder (section,
  nature of payment, threshold, rate with PAN, rate without PAN). If it isn't available, say so and stop: rates and
  thresholds change by year and must come from the firm's own reviewed table, not from memory.

## Checks (one sheet each, plus Summary)

1. **Section vs nature**: payments booked under an expense head whose usual section (from the rate table) differs
   from the section used.
2. **Rate**: deduction rate differs from the table rate for the section (with or without PAN).
3. **Threshold crossed without deduction**: party-wise payments in the year above the table threshold with no TDS.
4. **PAN**: party PAN missing, or not in the format `AAAAA9999A` (format check only; validity is checked on the
   portal by a person).
5. **Late deduction / late payment**: deduction later than the credit or payment date, or deposit later than the
   due date in the firm's table; estimate interest using the rates in the firm's table and show the working.

Each row: Date (DD-MM-YYYY), Party, PAN, Ledger, Section used, Amount (₹), TDS (₹), What looks wrong, Working.

## Rules

- Read only. Estimates are labelled "estimate" and are for the CA to confirm.
- Never contact deductees and never touch TRACES or the income-tax portal.
- End with a short chat summary and the file location.
- If Windows refuses access to the client's folder, stop and say so; don't look for another copy.
