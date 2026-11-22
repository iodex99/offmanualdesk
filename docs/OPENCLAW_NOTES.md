# OpenClaw notes (verified facts only)

Every line needs a source: doc URL (prefer the `.md` version of docs.openclaw.ai pages) or source path + commit, and the version it applies to. Mark guesses as **UNVERIFIED** and don't build on them. When upgrading OpenClaw, re-verify every section and note changes.

Starting points from planning (re-verify; these were read in Nov 2026):
- Security / trust model: https://docs.openclaw.ai/gateway/security (one trust boundary per gateway; separate gateways, ideally separate OS users, for mixed trust; loopback bind default; DM pairing default)
- Multi-user mode: https://docs.openclaw.ai/concepts/multi-user (usability, not security)
- Multi-agent: https://docs.openclaw.ai/concepts/multi-agent
- Windows: https://docs.openclaw.ai/platforms/windows (native CLI + gateway; Scheduled Task startup; WSL2 most compatible)
- Trusted-proxy auth: https://docs.openclaw.ai/gateway/trusted-proxy-auth
- Telegram channel: https://docs.openclaw.ai/channels/telegram
- Updating: https://docs.openclaw.ai/install/updating
- ClawHub security audits: https://docs.openclaw.ai/clawhub/security-audits

## 1. Pinned version
- Version:
- Why:
- Release notes reviewed:

## 2. Install on Windows (native)
- Runtime requirements (Node version, etc.):
- Install layout we can relocate to `C:\Program Files\OffManual\versions\<v>\openclaw`:
- How to set the state directory per user:
- Env vars / flags:

## 3. Gateway
- Config file location and format:
- Bind address and port settings:
- Auth modes; forcing token auth on loopback:
- Client protocol (WS/HTTP) Desk will use:
- Disabling or protecting the Control UI:

## 4. Plugin SDK
- Manifest format, entry point, packaging:
- Loading local plugins from a fixed path:
- Lifecycle (init, shutdown), config injection:

## 5. Hooks for guard
- Before/after turn hooks; can they reject a turn?
- Before/after tool call hooks; can they block, modify, or replace with a result?
- What a tool failure looks like (errors for EACCES / Windows error 5):
- Per-channel context available to hooks:

## 6. Channel plugin interface (for channel-relay)
- Required methods/events:
- Message, attachment, button (inline keyboard) types:

## 7. Skills
- SKILL.md format and metadata:
- Loading skills only from a given directory:
- Disabling `skills install` / ClawHub at runtime:
- How skills declare binaries and permissions:

## 8. Updates and migrations
- `openclaw update`, `openclaw doctor` behaviour for our relocated install:
- State migration between versions:

## 9. Tool policy, sandbox, exec approvals, Lobster
- Tool allow/deny config per agent:
- Exec approvals:
- Lobster approval API:

## 10. Usage and diagnostics
- Token counts per turn / per session; how to export to Server Agent:

## Docs vs source disagreements

## Known gaps / open questions
