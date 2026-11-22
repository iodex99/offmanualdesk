---
name: ais-26as-vs-books
description: Compare TDS/TCS credits and reported income in a client's Form 26AS and AIS (downloaded files) with the books and invoices for a financial year, and save a difference report in the client's folder.
user-invocable: true
metadata: { "openclaw": { "os": ["win32"] } }
---

# AIS / 26AS vs books

Produces `TDS_Credit_Reco_<Client>_<FY>.xlsx` (FY like `FY2025-26`) in the client's folder. It compares; it never
changes the books and never logs in to the income-tax portal.

## Inputs

- Client and financial year.
- Form 26AS (PDF or text export) and the AIS/TIS (JSON, PDF or Excel) the firm downloaded into the client's
  folder. If they aren't there, say which files are needed and stop.
- Books: party-wise receipts and TDS receivable ledger from Tally (tally-read skill) or exported ledgers.

## Comparison

1. From 26AS: deductor TAN, deductor name, section, amount paid/credited, TDS/TCS deposited, date.
2. From books: party, invoices/receipts in the year, TDS receivable entries.
3. Map deductors to parties by name and TAN noted in the ledger (ask the user once for any unmapped deductor and
   remember the mapping in the client's folder file `Deductor_Map.xlsx`).
4. Compare per party: amount credited (26AS) vs income booked; TDS (26AS) vs TDS receivable (books).
5. From AIS: list information categories present (interest, dividend, securities, property, foreign remittance and
   so on) with totals, and mark which ones have no matching ledger in the books.

## Sheets

- **Summary**: totals per side and the differences.
- **TDS by party**: party, TAN, section, 26AS credit, books credit, difference.
- **In 26AS, not in books** and **In books, not in 26AS**.
- **AIS items to check**: categories and amounts with no matching ledger.

Every amount in ₹ with Indian grouping; dates DD-MM-YYYY.

## Rules

- Read only. Whether income is taxable, and in which year, is for the CA; flag, don't conclude.
- Never file a response or feedback on the portal.
- End with a short chat summary and the file location.
- If Windows refuses access to the client's folder, stop and say so; don't look for another copy.
