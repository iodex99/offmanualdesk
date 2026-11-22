---
name: ledger-scrutiny
description: Scrutinise a client's ledgers for a financial year and list entries that need a second look (round sums, large cash, missing narrations, duplicates, unusual dates), saved as an Excel file in the client's folder.
user-invocable: true
metadata: { "openclaw": { "os": ["win32"] } }
---

# Ledger scrutiny

Produces `Scrutiny_<Client>_<FY>.xlsx` in the client's folder (from the client directory) with entries worth
checking before finalisation or audit. It flags; it never changes the books.

## Inputs

- Client and financial year (e.g. "Mehta Traders FY2025-26" = 01-04-2025 to 31-03-2026).
- Ledgers: from Tally (tally-read skill) or an exported day book / ledger file in the client's folder. If neither
  is available, say what you need and stop.

## What to flag (one sheet per check, plus a Summary sheet)

1. **Cash payments above the daily limit**: cash payments to one payee on one day whose total exceeds the
   limit under the income-tax law (₹10,000 in general; confirm the current limit and exceptions for the year).
2. **Large cash receipts**: cash received from one person in one day, for one transaction or one event, at or
   above ₹2,00,000 (confirm the current limit).
3. **Round-sum entries**: amounts of ₹10,000 or more that are exact multiples of ₹1,000, in expense and loan
   ledgers.
4. **Missing or vague narrations**: empty narrations, or narrations of fewer than three words, in vouchers above
   ₹5,000.
5. **Possible duplicates**: same ledger, same amount, within 3 days, different voucher numbers.
6. **Unusual dates**: vouchers dated on Sundays, on the last day of the year above ₹1,00,000, or outside the
   financial year.
7. **Negative balances**: cash or stock ledgers that go negative on any day.

Each flagged row: Date (DD-MM-YYYY), Voucher type, Voucher no., Ledger, Party, Amount (₹, Indian grouping),
Narration, Why flagged.

## Rules

- Read only. Never alter, delete or post vouchers; corrections go through the review queue by a person.
- Amounts in ₹ with Indian digit grouping (1,23,456.00).
- Finish with a three-line summary in chat: total entries reviewed, flags per check, where the file is saved.
- If Windows refuses access to the client's folder, stop and say so; don't look for another copy.
