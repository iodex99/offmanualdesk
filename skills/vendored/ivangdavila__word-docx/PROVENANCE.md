# Provenance: ivangdavila/word-docx

- Source: https://clawhub.ai/ivangdavila/skills/word-docx (ClawHub API `GET /api/v1/download?slug=word-docx&ownerHandle=ivangdavila&version=1.0.2`)
- Upstream version: 1.0.2 (published 11-03-2026); homepage https://clawic.com/skills/word-docx
- Licence: MIT-0 (ClawHub version metadata and the upstream skill card); no attribution required, kept anyway.
- Downloaded: 25-11-2026 by Off Manual (Claude Code for Dwahnil); archive sha256 `433c586060f4e30d7c16e3a81b51eea994dfc12a0c131c05723d2414327499c7`
- Upstream file hashes (matched ClawHub's published `files[]`): `SKILL.md` c766da489810acf03290283780ba9d3be798678d689255ace34477caeb6d7541, `skill-card.md` ee543d852ff1ee291171a5c768b546451e93558e990dc0ae9e9ac1189da54364 (card not shipped; it only restates the licence and use case).
- Scan: instruction-only Markdown; no scripts, binaries, install steps, network calls or credentials. `tools/skill-vet` result in the session log.

## Changes made

1. `name` set to the folder slug `word-docx` (Desk shows skills by name, ADR-069).
2. `metadata.clawdbot` (no longer read by OpenClaw) replaced with `metadata.openclaw` and `os: ["win32"]`.
3. Removed the "Related Skills" and "Feedback" sections: they told the agent to run `clawhub install`/`star`/`sync`, and nothing is installed from ClawHub at runtime (rule 5).
4. Added an "Off Manual" section: stay within the employee's Windows rights, stop on Access Denied, save results as new files with the firm's naming rule.

## Review checklist

- Executes: nothing by itself (Markdown guidance). No code or commands; the assistant uses its normal file tools.
- Network destinations: none. The URLs here and the frontmatter `homepage` are metadata, never fetched.
- Files written: only what the employee asks for, saved as new files next to the source in folders they can open (added rule); Windows rights decide.
- Binaries: none.
- Third parties: none.
- Windows: OS set to `win32`; no POSIX-only tools.
- Output naming and portals: added rule for the firm's naming; nothing is submitted anywhere.

## Review

- Status: pending Dwahnil's approval in `skills/registry.lock.json`.
- Reviewer notes: see the session log entry of 25-11-2026 in PROGRESS.md.
