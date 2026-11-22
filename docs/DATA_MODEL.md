# Data model

Keep this file in step with `apps/console/db/schema.ts` and `apps/server-agent/internal/store/migrations`. Every migration updates this file in the same commit.

## 1. Console (Postgres, Drizzle)

IDs are UUIDv7 (`apps/console/lib/ids.ts`). Most tables have `created_at`, `updated_at`. Money in paise as `bigint`. Secrets encrypted at rest (envelope encryption, key in Vercel env). Source of truth: `apps/console/db/schema.ts`; migrations in `apps/console/db/migrations/` (drizzle-kit); applied by `pnpm --filter @offmanual/console db:migrate`. Implemented so far: every table below except the Billing section (M9). Servers are addressed on the wire as `srv_<uuid hex>`.

### Identity and tenancy
| Table | Key columns |
| --- | --- |
| `console_users` | email, name, role (`superadmin` / `staff`), totp_secret_enc (AES-256-GCM, AAD = column name), totp_enrolled_at, totp_last_counter, disabled_at |
| `sessions` | token_hash (sha256 of the cookie token) PK, kind (`console`/`firm_admin`), user_id, mfa_at (null until TOTP passed), expires_at (pre-MFA 10 min, full 12 h) |
| `firms` | name, legal_name, gstin, state_code, billing_email, billing_phone, status (`trial`/`active`/`overdue`/`restricted`/`suspended`/`closed`), rollout_ring, version_pin, data_note_signed_at, llm_key_mode (`firm`/`offmanual`) |
| `firm_admins` | firm_id, email (unique per firm), name, totp_secret_enc, totp_enrolled_at, totp_last_counter, role (`owner`/`admin`), disabled_at |
| `servers` | firm_id, hostname, public_key (unique, base64 ed25519), enrolled_at, revoked_at, last_heartbeat_at, agent_version, openclaw_version, desk_version, staged_version, health (`green`/`amber`/`red`), active_seats, preflight_json |
| `enrolment_codes` | firm_id, server_name, code_hash (sha256 of the upper-cased code; unique), expires_at, used_at, server_id |
| `agent_nonces` | (server_id, nonce) PK, expires_at: replay protection for signed agent requests (ADR-035) |
| `employees` | firm_id, name, email, windows_sid, windows_username, role_label, oauth_provider, oauth_subject, bound_at, totp_secret_enc, totp_enrolled_at, telegram_linked (bool only), status (`invited`/`active`/`disabled`), enabled_from, disabled_at, totp_reset_at (admin-requested authenticator reset, migration 0004, ADR-049) |
| `invites` | employee_id, channel (`email`/`whatsapp`), sent_at (set when Resend accepted the invite email), accepted_at (set when the employee binds) |
| `bind_codes` | employee_id, code_hash (sha256 of `bind:` + normalised code; unique), oauth_provider, oauth_subject, expires_at (10 min), used_at. One live code per employee; redeemed once by a Server Agent of the employee's firm (migration 0002, ADR-044) |

### Capabilities and policy
| Table | Key columns |
| --- | --- |
| `skill_packs` | key (`core`, `tally-read`, `tally-post`, `email-send`, `portals`, `admin`), name, skills (jsonb list of skill IDs), actions (jsonb allowlist), review_required (jsonb). Catalogue for the console UI only: what a pack allows on the server comes from the signed `skills/packs.json` (ADR-043) |
| `pack_grants` | firm_id, pack_key, ad_group (nullable), employee_id (nullable) |
| `firm_policies` | firm_id, lock_timeout_max_min, day_end_hour_ist (replaces working_day_hours; ADR-033), telegram_mode (`off`/`text`/`files`), telegram_unlock_max_min, telegram_allowed_packs, step_up_actions, gateway_idle_stop_hours, retention_days, version (bumped on change; agent ETag) |

### Releases
| Table | Key columns |
| --- | --- |
| `releases` | version, channel, severity (`normal`/`security`), deadline_at, manifest_url, payload_sha256, key_id, changelog_md, openclaw_version |
| `release_rings` | release_id, ring (0/1/2), promoted_at, promoted_by |

### Usage, audit, support
| Table | Key columns |
| --- | --- |
| `usage_daily` | firm_id, employee_id, date, input_tokens, output_tokens, turns, tasks_completed |
| `seat_days` | firm_id, employee_id, date, enabled (bool), active (bool) |
| `audit_summaries` | firm_id, date, category, count |
| `support_tickets` | firm_id, server_id, employee_id (only if in the same firm), ref (OM-XXXXXX, unique), description (≤ 500, employee's words), bundle (jsonb: server versions, licence, policy ETag, pre-flight, log tail; desk versions), bundle_url (unused), status, notes (migration 0005, ADR-050) |

### Billing (see BILLING.md)
| Table | Key columns |
| --- | --- |
| `contracts` | firm_id, version (unique per firm), starts_on, ends_on, payment_terms_days (15), grace_days (15), suspend_after_days (45), seat_count_mode, bands_mode, status (`draft`/`active`/`superseded`/`ended`), notes (migration 0003) |
| `contract_lines` | contract_id, spec (jsonb: the billing engine's ContractLine with paise as decimal strings, validated strictly by `parseLineSpec`), billed_invoice_id (one-time lines, set on issue) |
| `invoices` | firm_id, number (unique, set on issue), period_start (unique per firm), period_end, issued_on, due_on, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, status (`draft`/`issued`/`paid`/`void`; overdue is derived by the ladder), pdf_url |
| `invoice_lines` | invoice_id, contract_line_id, description, sac, quantity (text, e.g. "1.50 seats"), amount_paise |
| `payments` | invoice_id, provider (`razorpay`/`manual`), provider_ref, amount_paise, paid_at, method, recorded_by |
| `invoice_counters` | fy (`FY2026-27`), last_seq; incremented inside the issuing transaction |
| `ladder_overrides` | firm_id, state, reason (required), until, created_by; newest unexpired wins |
| `mandates` | firm_id, provider_ref, type (`upi_autopay`/`emandate`), status |
| `notifications` | firm_id, audience (`firm_admin`/`all_employees`/`offmanual`), trigger, title, body, channels (jsonb), send_at, sent_at |
| `notification_receipts` | notification_id, recipient, channel, delivered_at, seen_at |

## 2. Server Agent (SQLite, `C:\ProgramData\OffManual\agent.db`)

Schema: `apps/server-agent/internal/store/migrations/0001_init.sql` (STRICT tables, times as Unix seconds UTC, foreign keys on, WAL). Applied versions live in `schema_migrations`; an agent refuses to open a database with a newer schema. `meta` is key/value. `leases.port` is UNIQUE; `audit` is indexed on `ts`; the console-bound audit data is `AuditSummary` (category counts only).

| Table | Key columns |
| --- | --- |
| `meta` | server_id, key_id, policy_etag, licence_expires_at, last_console_contact_at |
| `employees` | sid, employee_id, name, status, packs (json), totp_secret_dpapi, totp_last_counter (highest accepted TOTP step; replay protection, ADR-030), totp_enrolled_at (migration 0002), totp_reset_applied_at (migration 0005; newest console reset applied, ADR-049), pin_hash (argon2id), recovery_codes_hash (JSON array of sha256("om-recovery:" + code) for unused codes; ADR-046). Rows come from console policy sync; employees missing from the policy are set `disabled` with their day grant and lease removed |
| `meta` keys | server_id, server_key_dpapi, console_url, policy_etag, policy_json, firm_status, last_console_contact_at, audit_summary_sent_through, telegram_bot_username, telegram_bot_token_dpapi, telegram_offset, relay_device_key_dpapi |
| `day_grants` | sid, granted_at, expires_at |
| `lock_state` | sid, desk_locked, telegram_unlocked_until, failed_pins, failed_codes, lockout_until |
| `leases` | sid, port (unique), token_hash, token_dpapi (migration 0003; for the Telegram relay, ADR-040), pid, started_at, last_seen_at |
| `telegram_links` | sid, telegram_user_id, linked_at; `telegram_link_codes` (code_hash, sid, expires_at, used_at) |
| `audit` | ts, sid, category, action, target (may contain path, never leaves the server), result, correlation_id |
| `usage` | date, sid, input_tokens, output_tokens, turns, tasks_completed |
| `notices` | id, kind (`update`/`billing`/`admin`), audience, title, body, created_at, ack (per sid in `notice_acks`) |
| `updates` | version, state (`available`/`downloading`/`staged`/`failed`/`active`), verified_at, error, severity (`normal`/`security`), deadline_at (migration 0004) |

## 3. Per-user state (`%LOCALAPPDATA%\OffManual\`)

- `openclaw-state\`: OpenClaw's own state (sessions, memory, plugin data). Format owned by OpenClaw; see OPENCLAW_NOTES.md.
- `openclaw-state\plugins\offmanual-guard\review.json` (path from `api.runtime.state.resolveStateDir()`): review queue `{ version: 1, nextId, items: [{ id, kind, params, summary, status (pending/approved/rejected/done/failed), createdAt, sessionKey?, decidedAt?, finishedAt?, result? }] }`. Written whole via temp file + rename; the last 200 finished items are kept; an item found `approved` at load (interrupted) becomes `failed` and is never re-run (ADR-041).
- `desk\settings.json`: hotkey, panel side, lock timeout (≤ firm max), language.
- `desk\version.json`: `{active, previous}` release versions this employee's gateway runs (ADR-048); absent = `current`.
- `backups\state-<unix seconds>`: copies of `openclaw-state` taken before Doctor runs (ADR-025); the newest 3 are kept.
- `desk\device.key`: the Desk gateway client's Ed25519 seed, DPAPI CurrentUser with app entropy (ADR-021). The gateway token itself is never written to disk; it lives in Desk's memory and the gateway's environment (and DPAPI machine-scope in agent.db for the relay, ADR-040).
