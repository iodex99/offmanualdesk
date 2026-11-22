---
paths:
  - "packages/openclaw-plugins/**"
  - "skills/**"
  - "apps/desk/**/gateway*"
---

# OpenClaw rules

- Before using any OpenClaw API, config key, hook, CLI flag or file format, check `docs/OPENCLAW_NOTES.md`. If it isn't there, verify it in the docs (`https://docs.openclaw.ai/<page>.md`) and the source at the pinned version, then add it to OPENCLAW_NOTES.md with the link/path and version.
- Never upgrade the pinned OpenClaw version inside a feature change. Upgrades are their own change: re-verify OPENCLAW_NOTES.md, run all plugin tests, ADR if behaviour changed.
- Vendored skills: never edit in place without recording the change in that skill's `PROVENANCE.md` and refreshing `registry.lock.json` via `tools/skill-vet`.
- Guard plugin must fail closed: if it can't reach the Server Agent or read policy, it rejects the turn with a plain message.
