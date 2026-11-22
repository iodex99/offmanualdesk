# How to use this kit

1. Create an empty private GitHub repo `offmanual-desk`, clone it, and copy everything from this kit into its root (including the hidden `.claude/` folder and `.gitignore`).
2. Make sure `node --version` is 18 or newer and `git` works in the same terminal. Commit: `git add -A && git commit -m "chore: project kit"`.
3. Start Claude Code in that folder. It loads `CLAUDE.md` (which pulls in `PROGRESS.md`) and the hooks automatically. Approve the hooks if it asks.
4. Paste everything below the line in `BUILD_PROMPT.md` as your first message.
5. Every later session: start Claude Code and type `/pickup`.

What keeps the memory up to date:

| Piece | What it does |
| --- | --- |
| `CLAUDE.md` | Loaded every session; imports `PROGRESS.md`; map of all docs; non-negotiable rules |
| `.claude/rules/*.md` | Security rules always; OpenClaw, Windows and console rules load when those folders are touched |
| SessionStart hook | Prints current focus, next step, open items for you, last session log entries and git state, at startup, resume, clear and after compaction |
| Stop hook | Blocks Claude Code from ending a turn if code changed after `PROGRESS.md` was last updated, and tells it to run the checkpoint steps (reminds once per change set) |
| PreCompact hook | Same check before context is compacted |
| `/checkpoint` | Updates PROGRESS, CHANGELOG, DECISIONS, docs, OPENCLAW_NOTES |
| `/pickup` | Reloads state at the start of a session |
| `/adr` | Records a decision |
| `/lab-result L4` | Records a lab run you paste, updates the decisions it affects |

When Claude Code asks you to run a lab script on the Windows Server VM, run it, paste the whole output back, and type `/lab-result <id>`.
