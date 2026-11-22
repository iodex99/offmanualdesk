---
name: doc-chaser
description: For a period, check each client's folder for the documents the firm expects (bank statements, sales and purchase data, GSTR-2B, Form 16 and so on) and list who is missing what, as an Excel sheet the team can follow up from.
user-invocable: true
metadata: { "openclaw": { "os": ["win32"] } }
---

# Document chaser

Produces `Missing_Documents_<Period>.xlsx` in the firm's reports folder (from the client directory). It lists
what is missing; it never contacts clients.

## Inputs

- Period (month, quarter or financial year) and optionally a group of clients (by partner or by service).
- The firm's checklist `Document_Checklist.xlsx` in the firm's reference folder: service (GST monthly, TDS
  quarterly, ITR yearly, audit), document name, expected file name pattern, folder within the client folder. If
  it isn't there, offer a starter checklist for the user to save and edit, and stop.
- The client directory (client-directory skill) for client names, services and folders.

## Steps

1. For each client and each service they take, look for each expected document in the client's folder for the
   period, using the checklist's file name patterns (case-insensitive; dates in names as DD-MM-YYYY,
   YYYY-MM or month names).
2. A document counts as present only if a matching file exists and is not empty.
3. Clients the user can't open (Windows denies access) are listed as "No access" and skipped; never look for
   copies elsewhere.

## Output

- **By client**: client, partner, service, missing documents, last file seen in the folder (date).
- **By document**: document, clients missing it.
- **Summary**: clients complete, clients with gaps, clients not accessible.

## Rules

- Read only. Reminder emails or WhatsApp messages to clients are separate, reviewed actions by a person.
- End with a short chat summary: how many clients have gaps, the top three missing documents, file location.
