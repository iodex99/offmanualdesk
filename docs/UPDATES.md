# Updates

A tagged commit becomes a signed release that every assigned server stages; employees see a notice and switch with one click.

## 1. Release workflow (`.github/workflows/release.yml`)

Trigger: tag `v*.*.*` on `main`.

1. Build Server Agent (Go), Desk (Tauri), guard + channel-relay plugins, shared schemas.
2. Fetch the pinned OpenClaw version and Node runtime (versions from `release.config.json`; SHA-256 checked).
3. Build the skill pack from `skills/registry.lock.json`; fail if any file hash differs from the lock.
4. Run tests, lint, skill scanners (`tools/skill-vet`), secret scan.
5. Authenticode-sign every `.exe`/`.dll` (cert or Azure Trusted Signing).
6. Zip `versions/<semver>/` payload; write `manifest.json` (version, files + SHA-256, payload SHA-256, OpenClaw version, min agent version, severity, deadline, key_id); sign with ed25519 (`tools/sign-manifest`).
7. Upload payload + manifest to release store; `POST` console `/api/releases` (release record, ring 0).
8. Build MSI (first install only) from the same payload.
9. Move CHANGELOG Unreleased → version section; commit back.

## 2. Rings

0 = Off Manual lab server, 1 = pilot firm(s), 2 = all. Superadmin promotes in the console. A firm can be pinned to a version (support cases). Security releases can skip straight to ring 2 with a deadline.

## 3. Staging (Server Agent)

1. Learns of the assigned release via SSE push or 15-min poll.
2. Downloads payload to `staging\`, verifies manifest signature (embedded public keys by key_id), payload hash, every file hash, Authenticode on binaries.
3. Unpacks to `versions\<new>\`, reports `staged`. Does **not** move `current` until no employee gateway runs the old version, or for new gateway starts only (decide in M8; record ADR).
4. Server Agent self-update: staged like everything else, swapped by a small updater that restarts the service.

## 4. Desk notice and switch

- Notice: "Off Manual <v> is ready — what's new. Restart to update." Firm admin also sees who is still on the old version.
- Restart to update: stop the employee's gateway → run `openclaw doctor` (state migration; verify exact command in OPENCLAW_NOTES.md §8) → start from new version → health check → on failure, roll back that user to the previous version and report.
- Security release: after `deadline_at`, Desk switches automatically at the next lock or idle period.

## 5. Rollback

Last two versions stay on disk. Superadmin rolls a firm back from the console (pin to previous); Desks follow the same notice-and-restart flow.

## 6. Upstream changes

OpenClaw releases and upstream skill updates never reach a firm directly: pull into the repo, read the diff, re-scan, update the lock and OPENCLAW_NOTES.md, ship through §1.
