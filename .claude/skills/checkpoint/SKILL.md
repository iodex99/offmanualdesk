---
name: checkpoint
description: Update the project memory files (PROGRESS.md, CHANGELOG.md, DECISIONS.md, affected docs, OPENCLAW_NOTES.md) so nothing lives only in the conversation. Use after every code or config change, before ending a turn, before compaction, and whenever the Stop hook asks for it.
argument-hint: [short title of what was done]
---

# Checkpoint

Title for this checkpoint: $ARGUMENTS (if empty, write one yourself in under 8 words).

## Current changes

!`git status --porcelain --untracked-files=all`

!`git diff --stat`

## Steps (all of them, in this order)

1. **PROGRESS.md**
   - Tick finished checklist items; add new items you discovered under the right milestone.
   - Rewrite **Current focus** (one line) and **Next step** (1–3 concrete actions a fresh session can start on without asking).
   - Update **Waiting on Dwahnil** (add with exact steps; tick what he has done).
   - Add a Session log entry at the TOP of the log:
     ```
     ### YYYY-MM-DD HH:MM: <title>
     - Changed: …
     - Files: …
     - Tests: <command> → pass/fail (numbers)
     - Half-done / next: …
     ```
   - If the log has more than 15 entries, fold the oldest into a one-paragraph summary per milestone under **Done summary**.
2. **CHANGELOG.md**: one line per user-visible or developer-visible change under Unreleased (Added / Changed / Fixed / Security).
3. **DECISIONS.md**: if you chose between options, add an ADR with the template (`/adr`). If you reversed one, mark it *Superseded by ADR-0xx*. Promote *Proposed* ADRs to *Accepted* when their lab item passed.
4. **docs/**: for each changed area, make the matching doc describe the system as it is now (ARCHITECTURE flows/IPC/paths/ports, DATA_MODEL tables, BILLING rules, UPDATES pipeline, SKILLS registry/packs, PRODUCT features). Update [A]/[V] markers in ARCHITECTURE.md.
5. **docs/OPENCLAW_NOTES.md**: add every OpenClaw fact you verified, with URL or source path and version.
6. **CLAUDE.md**: only if commands, repo map or rules changed. Keep it under ~120 lines.
7. Re-read your edits once for contradictions between files. Fix them.
8. Reply with a 3-line summary: what changed, where the memory now points next, anything waiting on Dwahnil.
