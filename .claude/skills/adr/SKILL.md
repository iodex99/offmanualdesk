---
name: adr
description: Record an architecture decision in DECISIONS.md using the project template. Use whenever you choose between options, reverse an earlier decision, or a lab result changes a Proposed decision.
argument-hint: [decision title]
---

# New ADR: $ARGUMENTS

1. Open `DECISIONS.md`, find the highest ADR number, use the next one.
2. Append at the end:
   ```
   ## ADR-0xx: <title>
   - Date: <today, YYYY-MM-DD>
   - Status: Proposed | Accepted
   - Context: <why a decision was needed; link lab item, issue or doc section>
   - Options: A … / B … / C … (with the main trade-off of each)
   - Decision: <the choice>
   - Consequences: <what gets easier, harder, what to revisit and when>
   - Depends on: <lab item / ADR, if any>
   ```
3. If this replaces an earlier ADR, change that ADR's status line to `Superseded by ADR-0xx` (don't delete or rewrite it).
4. Update the docs the decision affects in the same turn.
5. Use *Proposed* if it depends on an unrun lab item or is expensive to reverse and Dwahnil hasn't agreed; say so in your reply.
