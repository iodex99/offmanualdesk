---
paths:
  - "apps/console/**"
---

# Console rules

- Every schema change: Drizzle migration + `docs/DATA_MODEL.md` updated in the same commit.
- Money in paise (`bigint`); display ₹ with Indian grouping; dates stored UTC, shown IST as DD-MM-YYYY.
- Role checks on the server for every route and API (superadmin, staff, firm admin scoped to their firm). Firm admins can never read another firm's rows; add a test for each new query.
- Agent API routes verify the ed25519 request signature and timestamp before anything else (ADR-013).
- Billing logic lives in pure functions with unit tests covering every line type, both seat modes, GST same-state and inter-state, proration and the ladder (docs/BILLING.md).
- Never accept client content (prompts, file names, contents) in any API. Reject unknown fields.
