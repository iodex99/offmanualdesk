# Changelog

All notable changes. Format: Keep a Changelog; versions follow SemVer. Claude Code adds a line under **Unreleased** for every change; `node tools/release/cli.mjs prepare <version>` moves them under the new version (ADR-017).

## Unreleased

### Added
- Project kit: CLAUDE.md, PROGRESS.md, DECISIONS.md, docs/, Claude Code hooks and skills.
- Monorepo scaffold: pnpm workspace (console, desk, shared-schema, guard, channel-relay), Go workspace (server-agent, sign-manifest), Tauri 2 Desk with React UI, Next.js console with `/api/health`.
- Server Agent `version`/`help` commands with build info injected at link time.
- Release manifest library (`apps/server-agent/pkg/manifest`): ed25519 signature over exact manifest bytes, deterministic payload zip, strict parsing, zip-slip and zip-bomb safe extraction, directory verification.
- `tools/sign-manifest` CLI: keygen, build, sign (key only from env), verify.
- `tools/release` CLI: prepare (CHANGELOG roll + version bump), check-tag, notes, verify-skills.
- Shared JSON Schemas for the release manifest, its signature and pipe messages, with a golden fixture tested from both TypeScript and Go.
- Indian formatting helpers: ₹ with Indian grouping from integer paise, DD-MM-YYYY in IST, FY labels, invoice numbers.
- Guard plugin: access-denied classifier (EPERM/EACCES/Win32/HRESULT/text), OpenClaw packaging (`openclaw.plugin.json`, built `dist/plugin.js`) and an install block, typed against `openclaw@2026.11.6`.
- CI workflow: format, lint, typecheck, tests, Go on Windows and Linux, golangci-lint, Rust fmt/clippy/test on Windows, lab-script parsing, actionlint, gitleaks.
- Release workflow: tag-triggered build, pinned Node + OpenClaw with hash checks, skills-lock check, Authenticode (when configured), signed manifest, GitHub pre-release, optional release store and console registration; dry-run mode.
- Lab validation scripts L1–L10 with a runbook for the Windows Server 2022 RDS lab.
- Automated tests for the Claude Code memory hooks.

### Changed
- OpenClaw pinned to 2026.11.6 and Node runtime to 24.22.3 (ADR-019).
- ARCHITECTURE flows F4–F7 rewritten from verified OpenClaw behaviour; several assumptions now carry Proposed ADRs (020–028).

### Fixed
- Memory hooks: removed a dead initial assignment flagged by ESLint.

### Security
- Server Agent pipe ACL tightened to explicit rights plus first-instance flag and server identity check, after the lab self-test showed generic write allows pipe squatting (ADR-029).
- Gateway config must set `gateway.auth.rateLimit.exemptLoopback: false`; OpenClaw's default exempts loopback, which on an RDS host means every session (ADR-021).
- Install scripts of the OpenClaw SDK dependency disabled in the workspace; release payload installs OpenClaw with `--ignore-scripts` from a lockfile.
