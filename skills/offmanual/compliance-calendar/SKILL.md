---
name: compliance-calendar
description: List upcoming GST, TDS, advance tax, income-tax and ROC due dates for the firm's clients, with who each applies to, and remind about the ones due this week.
user-invocable: true
metadata: { "openclaw": { "os": ["win32"] } }
---

# Compliance calendar

Answers "what's due this week?", "which clients have GSTR-3B due on the 20th?" and builds a month view.

## Ground rules

- **Due dates change by government notification** (extensions, new forms, the new Income-tax Act applying from
  FY2026-27). The table below is a baseline to plan with, not the final word. Before telling anyone a date is
  final, say: "Check the official portal for any extension." Never file anything yourself.
- Weekends and holidays: if a due date falls on one, say so; don't assume an automatic extension.
- Use DD-MM-YYYY and FY labels like FY2025-26.

## Baseline schedule (review each financial year)

| Return / payment | Who | Usual due date |
| --- | --- | --- |
| GSTR-1 (monthly filers) | GST-registered, monthly | 11th of the next month |
| GSTR-1 IFF / quarterly (QRMP) | QRMP scheme | 13th of the month after the quarter |
| GSTR-3B (monthly) | Monthly filers | 20th of the next month |
| GSTR-3B (quarterly, QRMP) | QRMP scheme | 22nd or 24th after the quarter, by state group |
| GST annual return | As notified for the year | 31 December after the year |
| TDS/TCS deposit | Deductors | 7th of the next month; March deductions by 30 April |
| TDS/TCS quarterly statements | Deductors | 31 July, 31 October, 31 January, 31 May |
| Advance tax instalments | Taxpayers liable | 15 June, 15 September, 15 December, 15 March |
| Income-tax return, non-audit | Individuals/HUF etc. not under audit | 31 July |
| Tax audit report | Audit cases | 30 September |
| Income-tax return, audit cases | Audit cases | 31 October |
| Company annual filings | Companies | Financial statements within 30 days and annual return within 60 days of the AGM |
| Director KYC | Directors | 30 September |

## How to answer

1. Read the client directory (client-directory skill) to know each client's registrations: GSTIN present →
   GST items; TAN or salary/contract payments → TDS items; company → ROC items. If you don't know whether an
   item applies, list the client under "check applicability" rather than guessing.
2. For "due this week": list items due in the next 7 days, soonest first, as `DD-MM-YYYY — Return — Clients`.
3. For a month view, create `Compliance_<MMM-YYYY>.xlsx` in `\\<file server>\Clients\_OffManual\` with one row per
   client per item: Client, Item, Due date, Status (blank for staff to fill), Notes.
4. Never mark anything as filed; staff update the Status column.
