# Security rules (always loaded)

- Identity comes from the OS (pipe client token → SID), never from a request body.
- Never work around Access Denied: no elevation, no alternate path, no copying, no retries as another account.
- Every gateway: loopback, unique port, unique token. Never disable gateway auth, even for tests on a shared host.
- No ClawHub or `skills install` at runtime. Skills only from `skills/` with matching hashes in `registry.lock.json`.
- Irreversible/external actions → review queue. Portal OTP/DSC steps are never automated.
- Logs and console payloads: metadata only. No prompts, model output, file contents, file names, PAN/Aadhaar/GSTIN, tokens.
- Secrets only via environment or OS secret stores (DPAPI, GitHub secrets, Vercel env). Never in code, tests, fixtures or commits. Use `.env.example`.
- Any change that weakens a rule in docs/SECURITY.md needs a Proposed ADR and Dwahnil's explicit approval.
