---
name: lab-result
description: Record a Windows Server lab run that Dwahnil pasted, and update every ADR and doc it affects.
argument-hint: [lab item id, e.g. L4]
disable-model-invocation: true
---

# Record lab result for $ARGUMENTS

1. Read the pasted output in the conversation. If something needed for pass/fail is missing, ask for exactly that and stop.
2. Save the raw output to `lab/results/$ARGUMENTS-<YYYY-MM-DD>.txt` (remove any secrets, tokens, real client names).
3. In `docs/LAB_VALIDATION.md`: set Status (PASS / FAIL / PARTIAL) and a one-line Result in the table, and add a Results log entry at the top with environment, output summary, conclusion, and what you changed.
4. Update every ADR listed under "Affects": promote *Proposed* → *Accepted* on pass; on fail write a new ADR with the alternative and mark the old one superseded.
5. Flip the matching [A] markers in `docs/ARCHITECTURE.md` to [V] or rewrite the flow.
6. Update PROGRESS.md (tick the lab item, adjust Next step) and run the rest of `/checkpoint`.
7. Tell Dwahnil in 3 lines what the result means for the build.
