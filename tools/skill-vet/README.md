# skill-vet (M7)

Static checks for a skill before it enters `skills/` (docs/SKILLS.md §2): network calls, shell exec, file writes
outside allowed roots, obfuscation, base64 blobs, install scripts, external binaries; wraps available scanners;
prints the human review checklist; refreshes `skills/registry.lock.json` hashes.

Until M7, the lock is verified by `node tools/release/cli.mjs verify-skills`.
