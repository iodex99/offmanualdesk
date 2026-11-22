# Billing

Every firm can have its own deal. A contract is a versioned list of line items; invoices are computed from the active contract version for the period. Amounts are in paise, displayed as ₹ with Indian grouping.

Implemented as pure functions in `apps/console/lib/billing/` (engine.ts, money.ts, ladder.ts; ADR-038). Rules that the text below leaves open are fixed in ADR-038.

## 1. Line types

| Type | Fields | Invoice calculation |
| --- | --- | --- |
| `one_time` | amount | Billed once on the next invoice after `starts_on` (setup, custom skill, training, migration) |
| `recurring_flat` | amount, interval (month/quarter/year) | Billed at the start of each interval (AMC, minimum monthly fee) |
| `per_seat` | rate or bands, interval month | By contract `seat_count_mode` (ADR-014): `prorated_enabled_days` = Σ seats (days enabled ÷ days in month) × rate; `peak_active` = max active employees on any day × rate. Bands: rate depends on the count (e.g. 1–10, 11–25, 26+), applied as tiers or as a single rate per contract flag `bands_mode` (`tiered`/`volume`) |
| `usage` | markup_pct, included_quota (tokens), rate per 1M tokens | Only when firm uses Off Manual's LLM key: (tokens − quota)+ × rate × (1 + markup) |
| `adjustment` | pct or amount, starts_on, ends_on | Discounts, waiver months, prepaid credit, price lock |

Admins' seats can be marked free via an `adjustment` line.

## 2. GST

- Off Manual's GSTIN and state are configuration (`OFFMANUAL_GSTIN`, `OFFMANUAL_STATE_CODE`), SAC code per line (default from config). Confirm with Off Manual's CA before going live; until then invoices are drafts only.
- Same state as firm → CGST 9% + SGST 9%; different state → IGST 18%. Rate is configuration, not hard-coded.
- Invoice number series per financial year: `OM/FY2026-27/0001`.
- Invoice PDF includes both GSTINs, place of supply, SAC, taxable value, tax split, total in words (Indian numbering).

## 3. Invoice run

- Monthly on the 1st (IST) for the previous month's seats and usage, plus the current interval's recurring lines and pending one-time lines.
- Draft → reviewed by superadmin (first 3 months per firm) → issued → email + Desk banner to firm admins.
- Mid-month contract changes: lines prorated by days under each version.

## 4. Payments

- Razorpay: payment link on every invoice; UPI AutoPay or e-mandate for recurring lines when the firm opts in; webhook marks `paid`.
- Manual payments (NEFT/cheque) recorded by superadmin.
- Receipts emailed automatically.

## 5. Notifications

| Trigger | Audience | Channels |
| --- | --- | --- |
| Invoice issued | Firm admins | Desk banner, email |
| Due in 7 days, due today | Firm admins | Desk banner, email, WhatsApp (v2) |
| Overdue | Firm admins | Persistent Desk banner |
| Grace ends in 3 days | Firm admins, then all employees (last day) | Desk banner |
| AMC renewal in 30 days | Firm admins | Desk banner, email |
| Seat limit of contract reached | Firm admins | Desk banner; new seats wait for approval |
| Payment received | Firm admins | Email |
| Any of the above | Off Manual | Console feed |

## 6. Enforcement ladder (per contract, days configurable)

`active` → due date passes → `overdue` (banner only) → `grace_days` pass → `restricted` (no new seats or packs) → `suspend_after_days` pass → `suspended` (Desk opens for firm admins only; no data deleted; Telegram replies "service paused, contact your admin"). Superadmin can override any state for a firm with a reason (logged).

Offline rule: if the Server Agent can't reach the console, the licence keeps working for `offline_grace_days` (default 7) before any ladder step applies.
