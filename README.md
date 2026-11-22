# Off Manual Desk

A managed AI assistant for Indian CA firms, built on [OpenClaw](https://docs.openclaw.ai), installed on the
firm's Windows RDS server. Every employee gets their own assistant, running as their own Windows account, so
the firm's existing NTFS and share permissions decide what it can open.

Start with [CLAUDE.md](CLAUDE.md) (map of everything) and [PROGRESS.md](PROGRESS.md) (where the build is).

| Part | Path | Stack |
| --- | --- | --- |
| Server Agent (Windows service) | `apps/server-agent` | Go |
| Desk (per-employee app) | `apps/desk` | Tauri 2 + React + TypeScript |
| Console + agent API | `apps/console` | Next.js + Postgres (Drizzle) on Vercel |
| OpenClaw plugins | `packages/openclaw-plugins/{guard,channel-relay}` | TypeScript |
| Shared schemas | `packages/shared-schema` | JSON Schema + TS (+ Go mirror) |
| Skill registry | `skills/` | Pinned, reviewed, signed |
| Release tooling | `tools/release`, `tools/sign-manifest` | Node, Go |
| Lab validation | `lab/` | PowerShell |

## Develop

Requirements: Node 22+, pnpm (version in `package.json`), Go (version in `apps/server-agent/go.mod`), Rust stable
with the MSVC toolchain (Visual Studio Build Tools) for Desk.

```sh
pnpm install
pnpm run check                       # format, lint, typecheck, all TS tests, hook + release-tool tests
go test ./apps/server-agent/... ./tools/sign-manifest/...
cd apps/desk/src-tauri && cargo clippy --all-targets -- -D warnings && cargo test
```

## Release

```sh
node tools/release/cli.mjs prepare 1.2.0   # rolls CHANGELOG, bumps every version
git commit -am "chore(release): v1.2.0" && git tag -a v1.2.0 -m v1.2.0 && git push origin main v1.2.0
```

The tag triggers `.github/workflows/release.yml`: CI, build, hash-checked Node + OpenClaw, skills-lock check,
Authenticode, signed manifest, GitHub Release. See [docs/UPDATES.md](docs/UPDATES.md).
