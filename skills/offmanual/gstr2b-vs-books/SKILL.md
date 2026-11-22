---
name: gstr2b-vs-books
description: Match a client's GSTR-2B (downloaded from the GST portal) with the purchase register from Tally or an export, and save a mismatch report in the client's folder for the tax period.
user-invocable: true
metadata: { "openclaw": { "os": ["win32"] } }
---

# GSTR-2B vs books

Produces `GSTR2B_Recon_<Client>_<Period>.xlsx` (Period like `Nov-2026`) in the client's folder. It compares;
it never changes the books and never touches the GST portal.

## Inputs

- Client and tax period (month or quarter).
- GSTR-2B: the JSON or Excel file the firm downloaded from the GST portal into the client's folder. If it isn't
  there, say which file is needed and stop. Never log in to the portal.
- Purchase register for the same period: from Tally (tally-read skill) or an exported register in the folder.

## Matching

1. Normalise both sides: supplier GSTIN (upper case, 15 characters), invoice number (trim, upper case, drop
   spaces, `/` and `-` differences noted but compared both ways), invoice date (DD-MM-YYYY), taxable value and
   tax heads (IGST, CGST, SGST, cess).
2. Match on GSTIN + normalised invoice number. A match is **exact** when taxable value and every tax head agree
   within ₹1.
3. Unmatched lines: try GSTIN + amount within ₹1 + date within 7 days, and mark them **probable** (a person
   confirms).

## Sheets

- **Summary**: counts and ITC totals for each group below, per tax head.
- **Matched**: exact matches.
- **Value differences**: same invoice, different amounts (show both sides and the difference).
- **In 2B, not in books**: possible missed purchase entries.
- **In books, not in 2B**: ITC at risk (supplier may not have filed); include supplier GSTIN and invoice details
  so the firm can follow up.
- **Probable matches**: for a person to confirm.

Every amount in ₹ with Indian grouping; dates DD-MM-YYYY.

## Rules

- Read only. ITC eligibility, blocked credits and time limits are for the CA to decide; flag, don't conclude.
- Never send anything to suppliers or the portal; a follow-up email is a separate, reviewed action.
- End with a short chat summary: matched count, ITC in books not in 2B (₹), where the file is saved.
- If Windows refuses access to the client's folder, stop and say so; don't look for another copy.
