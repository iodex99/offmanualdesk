# Private skill registry

Policy: [docs/SKILLS.md](../docs/SKILLS.md). Nothing from ClawHub runs on a client server unless it is here,
read line by line, scanned, pinned by hash in `registry.lock.json` and shipped in a signed release.

- `vendored/<owner>__<slug>/`: exact upstream copy + `PROVENANCE.md` (source, version, upstream hash, reviewer, notes, changes).
- `offmanual/<skill>/`: Off Manual's own skills (India pack, task buttons, client directory).
- `registry.lock.json`: every skill's id, version, path, packs, review record and SHA-256 of every file.

Check: `node tools/release/cli.mjs verify-skills` (runs in CI and in the release workflow; any unlisted,
changed or unapproved file fails the build). Vetting tooling (`tools/skill-vet`) arrives in M7.
