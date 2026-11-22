---
name: pickup
description: Reload project state at the start of a session or after compaction and continue from PROGRESS.md's Next step.
disable-model-invocation: true
---

# Pick up where the last session stopped

## State

!`git log --oneline -15`

!`git status --porcelain --untracked-files=all`

## Steps

1. Read `PROGRESS.md` fully: Current focus, Next step, Waiting on Dwahnil, the last three Session log entries.
2. Read the last five ADRs in `DECISIONS.md` and any marked *Proposed*.
3. Read the `docs/*.md` files the next step touches (map in CLAUDE.md). If the next step touches OpenClaw, read `docs/OPENCLAW_NOTES.md`.
4. If uncommitted changes exist, work out from the Session log whether they are finished; if a half-done item is recorded, finish it first.
5. In 3–5 lines tell Dwahnil: where things stand, what you'll do now, and anything still waiting on him.
6. Start the work.
