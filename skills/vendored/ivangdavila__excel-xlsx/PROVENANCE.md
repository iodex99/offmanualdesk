# Provenance: ivangdavila/excel-xlsx

- Source: https://clawhub.ai/ivangdavila/skills/excel-xlsx (ClawHub API `GET /api/v1/download?slug=excel-xlsx&ownerHandle=ivangdavila&version=1.0.2`)
- Upstream version: 1.0.2 (published 11-03-2026); homepage https://clawic.com/skills/excel-xlsx
- Licence: MIT-0 (ClawHub version metadata and the upstream skill card); no attribution required, kept anyway.
- Downloaded: 25-11-2026 by Off Manual (Claude Code for Dwahnil); archive sha256 `c3f33f6559f899573ae8a12c206ce5f3c4647a6c1fefd5ce569292fe5f4344ec`
- Upstream file hashes (matched ClawHub's published `files[]`): `SKILL.md` 52421d9fba8fdb64124416c450849434f3639e7b95249ce10fecd209aa90f038, `skill-card.md` 1ca3fbe81c9663f3b852a7a011e5e884d3f4f9b4ba198792cb4fe2a368eb1118 (card not shipped; it only restates the licence and use case).
- Scan: instruction-only Markdown; no scripts, binaries, install steps, network calls or credentials. `tools/skill-vet` result in the session log.

## Changes made

1. `name` set to the folder slug `excel-xlsx` (Desk shows skills by name, ADR-069).
2. `metadata.clawdbot` (no longer read by OpenClaw) replaced with `metadata.openclaw` and `os: ["win32"]` plus `requires.anyBins: ["python","py"]` (always satisfied: Off Manual ships Python 3.14 with openpyxl and pandas and puts it first on the assistant's PATH, ADR-072; the gate stays as a safety net).
3. Removed the "Related Skills" and "Feedback" sections: they told the agent to run `clawhub install`/`star`/`sync`, and nothing is installed from ClawHub at runtime (rule 5).
4. Added an "Off Manual" section: stay within the employee's Windows rights, stop on Access Denied, save results as new files with the firm's naming rule.

## Review checklist

- Executes: nothing by itself (Markdown guidance). Its examples have the assistant run Python (`openpyxl`, `pandas`) through the `exec` tool, using the Python Off Manual ships (ADR-072); the skill tells it never to `pip install`.
- Network destinations: none. The URLs here and the frontmatter `homepage` are metadata, never fetched.
- Files written: only what the employee asks for, saved as new files next to the source in folders they can open (added rule); Windows rights decide.
- Binaries: the bundled Python 3.14.10 with openpyxl 3.1.5 and pandas 3.1.1 (`release/python/python.lock.json`, hash-pinned).
- Third parties: none.
- Windows: OS set to `win32`; no POSIX-only tools.
- Output naming and portals: added rule for the firm's naming; nothing is submitted anywhere.

## Review

- Status: approved by Dwahnil on 25-11-2026 (`skills/registry.lock.json`).
- Reviewer notes: see the session log entry of 25-11-2026 in PROGRESS.md.
