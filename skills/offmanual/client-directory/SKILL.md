---
name: client-directory
description: Build or update the firm's client directory (client name → folder, Tally company, GSTIN, PAN, partner) from the Clients share and Tally, and look clients up by name.
user-invocable: true
metadata: { "openclaw": { "os": ["win32"] } }
---

# Client directory

Employees say "Mehta Traders FY2025-26", not paths. This skill keeps a directory that maps each client to
its folder, Tally company, GSTIN, PAN and partner, and resolves names people type to the right client.

## Where the directory lives

`\\<file server>\Clients\_OffManual\client-directory.csv` (the firm admin tells you the share path; never use a
mapped drive letter). Columns, in this order:

`client_name, folder_unc, tally_company, gstin, pan, partner, notes, updated_on`

- `updated_on` is DD-MM-YYYY.
- Keep one row per client. Never delete rows; mark a closed client in `notes`.

## Building or refreshing (admin task)

1. List the top-level folders of the Clients share. Each folder is a candidate client. Skip folders starting
   with `_` or `.`.
2. If Tally is available (tally-read skill), list its companies and match them to folders by name. Show the
   matches you are unsure about instead of guessing.
3. For GSTIN and PAN, only use values printed on documents inside that client's folder (GST registration
   certificate, PAN card, previous returns). Never invent or infer them.
   - GSTIN must match `^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$`, and its first two digits are the state
     code; characters 3–12 are the PAN. Flag any GSTIN whose embedded PAN differs from the PAN you found.
   - PAN must match `^[A-Z]{5}\d{4}[A-Z]$`.
4. Show the admin a table of proposed changes (new rows, changed fields) and save only after they approve.
5. If you can't open a folder, stop for that folder and say so; Windows permissions decide what you may read.
   Never try another path or copy files to get around it.

## Looking a client up

When someone names a client:

1. Match case-insensitively against `client_name`, then against `tally_company`, then by the words in the name
   ("Mehta Trd" → "Mehta Traders"). If more than one client matches, ask which one; never pick silently.
2. Use `folder_unc` for every file operation for that client, and `tally_company` for Tally.
3. Periods: "FY2025-26" means 01-04-2025 to 31-03-2026; "Oct 2025" means that calendar month.

## Privacy

- PAN and Aadhaar are personal data. In anything that leaves the firm's server (emails, Telegram), show PAN
  masked as `ABCXX1234X` (first three and last five characters kept only if needed; prefer the client name).
- The directory itself stays on the file server. Never paste it into chat in full; answer the question asked.
