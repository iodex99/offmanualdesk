# Updates

A tagged commit becomes a signed release that every assigned server stages; employees see a notice and switch with one click.

## 1. Release workflow (`.github/workflows/release.yml`)

**Status (2026-11-22):** workflow written and `actionlint`-clean; tooling (`tools/release`, `tools/sign-manifest`) unit-tested. First real run needs the repo on GitHub, the signing key secret, and `release/openclaw/` (see PROGRESS.md "Waiting on Dwahnil"). Steps marked *(M8)* are placeholders until that milestone.

**Prepare (local, ADR-017):** `node tools/release/cli.mjs prepare 1.2.0` moves CHANGELOG Unreleased → `## [1.2.0] - <date IST>` and bumps every versioned file (Desk `Cargo.toml` + `tauri.conf.json` + `package.json`, console and plugin `package.json`). Commit, `git tag -a v1.2.0`, push.

Trigger: tag `v*.*.*` (normal release), or *Run workflow* with an existing tag, `severity` (`normal`/`security`), `deadline_days`, and `dry_run` (default true: signs with a throwaway key, publishes nothing, needs no secrets).

1. Run the whole CI workflow (`ci.yml` via `workflow_call`): format, lint, typecheck, all tests, Go on Windows + Linux, Rust clippy/test, lab-script parse, actionlint, secret scan.
2. `cli.mjs check-tag`: every versioned file and the CHANGELOG section must equal the tag.
3. Build Server Agent (`-ldflags` version + commit), Desk (`tauri build --no-bundle`), plugins (sources until M5 fixes the packaging format from OPENCLAW_NOTES.md §4).
4. Node runtime: `nodejs.org` zip for `release.config.json` `node.version`, SHA-256 checked against `node.sha256`.
5. OpenClaw: `npm ci --omit=dev --ignore-scripts` from `release/openclaw/package-lock.json` (integrity-checked lock; version must equal `release.config.json` `openclaw.version`).
6. Skills: `cli.mjs verify-skills` (every file's SHA-256 matches `skills/registry.lock.json`, nothing unlisted, only `approved` skills), then copy the locked files. Skill scanners (`tools/skill-vet`) join in M7.
7. Authenticode-sign every `.exe`/`.dll` via Azure Trusted Signing when its secrets exist; otherwise warn "UNSIGNED (ring 0 only)".
8. `sign-manifest build`: deterministic `offmanual-<v>.zip` of the payload + `manifest.json` (ADR-015: schema, version, commit, createdAt, severity, deadlineAt for security releases, minAgentVersion, openclawVersion, nodeVersion, keyId, payload name/SHA-256/size, every file's path/SHA-256/size). `sign-manifest sign` (key only from env `RELEASE_SIGNING_KEY`) → `manifest.sig.json`; `sign-manifest verify` against the committed `apps/server-agent/pkg/manifest/keys/<keyId>.pub`, including a test extraction.
9. Publish (not on dry runs): GitHub pre-release with zip, manifest, signature, `SHA256SUMS.txt`, notes from CHANGELOG; upload to the release store if configured (ADR-016); `POST <console>/api/releases` (ring 0) if configured *(M8: endpoint)*.
10. MSI for first installs (built, ADR-071): `installer/OffManual.wxs` with WiX 7.0.1; the signed manifest is copied into the payload so the installed version folder looks like a staged release; `OffManual-<version>.msi` is attached to the GitHub release.

## 2. Rings

0 = Off Manual lab server, 1 = pilot firm(s), 2 = all. Superadmin promotes on the console's `/releases` page and sets each firm's ring and pin there; a pin to the previous version is the rollback. Only Authenticode-signed releases (manifest `authenticode: true`) leave ring 0 unless the console runs with `OM_ALLOW_UNSIGNED_RELEASES=true` (ADR-057). Security releases can skip straight to ring 2 with a deadline.

## 3. Staging (Server Agent)

Implemented (2026-11-23): `apps/server-agent/internal/update/stager.go`, driven by the 15-minute sync loop (`internal/console/sync.go`); console side `apps/console/lib/releases.ts`. SSE push is not built yet; polling only.

1. Learns of the assigned release via SSE push or 15-min poll (`GET /api/agent/releases`: the firm's pinned version, else the newest release promoted to a ring ≥ the firm's ring).
2. Downloads payload to `staging\`, verifies manifest signature (embedded public keys by key_id), payload hash, every file hash, and (when the signed manifest says `authenticode: true`) Authenticode on every .exe/.dll via WinVerifyTrust (ADR-055). The verification and safe-extraction code already exists in `apps/server-agent/pkg/manifest` (`Verify`, `VerifyFileHash`, `ExtractZip`, `VerifyDir`); M8 wires it into the service and adds `go:embed` of `pkg/manifest/keys/*.pub`.
3. Unpacks to `versions\<new>\`, reports `staged`. Employees' gateways move on their own *Restart to update* (§4). `current` (what new launches of the Server Agent, Desk and the guard bridge use) moves to the staged release between 02:00 and 05:00 IST when no gateway lease is active, or straight away once a security release's deadline has passed; never to an older version. The switch makes `current.next` (a junction), renames `current` away, renames the new one in, and restores the old one on failure (`internal/update/current.go`, ADR-062).
4. Server Agent self-update: after the switch the agent exits with an error; SCM recovery (set for non-crash failures too) starts `current\server-agent.exe`, i.e. the new release, 5 seconds later. The service is always registered through `current` (`install` rewrites a `versions\<v>\` path). Running Desks keep their binary until the employee's next sign-in.

## 4. Desk notice and switch

- Notice: "Off Manual <v> is ready — what's new. Restart to update." Firm admin also sees who is still on the old version: Desk reports its running release (`update.report`, after each check and switch), the heartbeat carries `employeeVersions`, and the console firm page has a Version column (ADR-063).
- Restart to update: stop the employee's gateway → run `openclaw doctor` (state migration; verify exact command in OPENCLAW_NOTES.md §8) → start from new version → health check → on failure, roll back that user to the previous version and report.
- Security release: after `deadline_at`, Desk switches automatically at the next lock or idle period.

Implemented (ADR-048): the Server Agent records the staged release's severity and deadline and answers `update.status`. Desk keeps each employee's choice in `%LOCALAPPDATA%\OffManual\desk\version.json` (`active`, `previous`) and starts the gateway from `versions\<active>` (else `current`). Restart to update: stop the gateway (lease released) → record the new choice → start; exit code 78 → snapshot → `openclaw doctor --fix --yes --non-interactive` → retry once. Any failure → restore the snapshot (the failed state is kept once as `openclaw-state.failed-<stamp>`), restore the previous choice, start again, and tell the employee. Security releases past `deadlineAt` are applied automatically when Desk opens the assistant. Desk and the Server Agent binaries themselves still update with the `current` switch (to build).

## 5. Rollback

Last two versions stay on disk. Superadmin rolls a firm back from the console (pin to previous); Desks follow the same notice-and-restart flow.

## 6. Upstream changes

OpenClaw releases and upstream skill updates never reach a firm directly: pull into the repo, read the diff, re-scan, update the lock and OPENCLAW_NOTES.md, ship through §1.
