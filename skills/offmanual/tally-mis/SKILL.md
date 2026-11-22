---
name: tally-mis
description: Build a client's month-end MIS from Tally data into the firm's Excel MIS template (sales, purchases, expenses, receivables and payables ageing, cash and bank) and save it in the client's folder.
user-invocable: true
metadata: { "openclaw": { "os": ["win32"] } }
---

# Tally MIS

Produces `MIS_<Client>_<Month-Year>.xlsx` in the client's folder, filled from the firm's template. It reads
Tally; it never posts or alters vouchers.

## Inputs

- Client and month (e.g. "Mehta Traders, Nov-2026").
- Tally data for the company through the tally-read skill (the client's own company in the user's Tally session).
- The firm's template `MIS_Template.xlsx` in the firm's reference folder. If it isn't there, offer a simple
  default layout (the sheets below) and say that the firm can replace it.

## Sheets (default layout)

1. **Summary**: sales, purchases, gross margin, expenses, net result for the month and year to date, with the
   same month last year where available.
2. **Sales and purchases**: by month for the financial year so far.
3. **Expenses**: by expense group, month and year to date.
4. **Receivables ageing**: party-wise outstanding in buckets 0-30, 31-60, 61-90, 90+ days as on month end.
5. **Payables ageing**: same buckets.
6. **Cash and bank**: closing balances by ledger.

## Rules

- Read only. If Tally isn't running, or the company isn't open in the user's Tally, say so and stop.
- Use the firm's template formatting; amounts in ₹ with Indian grouping (1,23,456.00), dates DD-MM-YYYY, FY as
  FY2026-27.
- Totals in the MIS must tie to Tally's trial balance for the month; if they don't, show the difference on the
  Summary sheet instead of hiding it.
- End with a short chat summary: month's sales, net result, total receivables over 90 days, file location.
- If Windows refuses access to the client's folder, stop and say so; don't look for another copy.
