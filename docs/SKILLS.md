# Skills

## 1. Principle

ClawHub is a parts bin. Nothing from it runs on a client server unless it has been copied into this repo, read line by line, scanned, pinned by hash and shipped inside a signed release. Off Manual's own skills (India pack, task buttons, client directory) are the product.

## 2. Registry policy

- `skills/vendored/<owner>__<slug>/`: exact copy of an upstream skill at a version, plus `PROVENANCE.md` (source URL, version, upstream hash, date, reviewer, review notes, changes made).
- `skills/offmanual/<skill>/`: Off Manual's skills.
- `skills/registry.lock.json`: every skill's ID, version, path, SHA-256 of every file, review status (`approved`/`rejected`), reviewer, date, packs it belongs to.
- Review status in the lock: `pending` (hash-checked in CI, never shipped) or `approved` (needs reviewer + date; shipped). Anything else fails the build (ADR-039).
- `tools/skill-vet` (`node tools/skill-vet/vet.mjs check|lock <dir>`): runs static checks (network calls, shell exec, file writes outside allowed roots, obfuscation, base64 blobs, install scripts, external binaries), wraps any available scanner, and prints a review checklist. A human approval line in PROVENANCE.md is required.
- Review checklist per skill: what it executes; every network destination; every file path it writes; binaries it needs and where they come from; whether it sends data to a third party (reject or replace "managed OAuth" proxies with direct APIs); Windows compatibility.
- Runtime: there is no single "only this directory" switch in OpenClaw (OPENCLAW_NOTES.md §7). Lockdown is layered (ADR-024, Proposed): `skills.load.extraDirs: [current\skills]`, `skills.allowBundled: []`, `agents.defaults.skills` allowlist, Skill Workshop off, `skill_workshop`/`plugins`/`openclaw`/`gateway` tools denied, `OPENCLAW_CONFIG_READONLY=1`, guard `before_install` block (implemented in `packages/openclaw-plugins/guard/src/plugin.ts`), `security.installPolicy` block, unexpected skill dirs removed before each gateway start.

## 3. Starter pack (Core, from ClawHub, review before shipping)

| Skill / plugin | Upstream | Pack | Notes |
| --- | --- | --- | --- |
| Tally reports + vouchers | `abhi152003/tally-skill` | tally-read / tally-post | XML over HTTP; split read and write; add read-back gate |
| Accountant | `ivangdavila/accountant` | core | |
| Bank recon vs GL | `chipmunkrpa/bank-recon-skill` | core | Add Indian bank statement formats |
| India GST toolkit | `sanketbhatia/india-gst` | core | Offline, stdlib Python |
| India ID check/mask | `sanketbhatia/india-id-check` | core | Masking for shared outputs |
| India income tax regimes | `sanketbhatia/india-income-tax` | core | |
| Excel | `ivangdavila/excel-xlsx` | core | |
| Word | `ivangdavila/word-docx` | core | |
| PDF extraction | `awspace/pdf` | core | |
| Google Workspace | `steipete/gog` | email-send (send), core (read) | Firms on Google |
| Outlook | `jotamed/outlook` | email-send (send), core (read) | Firms on M365; direct Graph |
| Telegram buttons | `ighniz/telegram-ui` (plugin) | core | Unlock + approvals |
| Approvals pipelines | `openclaw/lobster` (plugin) | — | Evaluated in M1: not used for the review queue; the guard owns it (ADR-028, Proposed) |
| Long-term memory | `openclaw/memory-lancedb` (plugin) | core | Per-employee state |
| Diagnostics | `openclaw/diagnostics-otel` (plugin) | core | Usage counts for console |
| Web search | `openclaw/duckduckgo-plugin` or `openclaw/brave-plugin` | core | Circulars, notifications |
| Skill vetting | `spclaudehome/skill-vetter` | internal only | Used in `tools/skill-vet`, never shipped |

Optional per firm (vet when a firm needs it): Zoho Books/Mail/CRM, Xero, QuickBooks KPO skills, OneDrive, PowerPoint, PDF merge/forms, OCR (one local engine), contract review, Hindi drafting, meeting notes, browser automation for portal downloads (no submissions). Full catalogue with reasons: the planning doc's "ClawHub catalogue" section.

## 4. India pack (build; ClawHub has none)

| Skill | What it does | Version |
| --- | --- | --- |
| `client-directory` | Builds/updates client list from the Clients share and Tally company list; resolves names to folder, Tally company, GSTIN, PAN, partner | v1 |
| `compliance-calendar` | Due dates for GST, TDS, advance tax, ITR, ROC with client applicability; reminders | v1 |
| `gstr2b-vs-books` | Matches GSTR-2B (portal JSON/Excel download) with purchase register from Tally; mismatch report | v1 |
| `ais-26as-vs-books` | TDS credits in AIS/26AS vs books and invoices | v1 |
| `tds-checks` | Section/rate sanity, PAN validity, late deduction interest estimate from ledgers | v1 |
| `ledger-scrutiny` | Flags unusual entries, round sums, cash > limits, missing narrations | v1 |
| `notice-reply-draft` | Reads a notice PDF, drafts a reply structure with facts to fill; never files | v1 |
| `doc-chaser` | List of clients missing documents for a period from folder contents | v1 |
| `tally-mis` | Month-end MIS from Tally data into the firm's Excel template | v1 |
| `form-3cd-helper` | Tax audit clause-wise data gathering | v2 |
| `roc-helper` | MCA filings checklist and data prep | v2 |
| `xbrl-helper` | Prepares tagging inputs | v2 |

Each India skill: offline where possible, Windows-compatible, writes outputs into the client folder using the naming rule in PRODUCT.md §4, never submits to a portal.

## 5. Task buttons v1 (per role)

| Button | Uses | Inputs | Output file |
| --- | --- | --- | --- |
| Bank reco | bank-recon, tally-read, excel | client, month, bank account | `BankReco_<Client>_<YYYY-MM>.xlsx` |
| GSTR-2B vs books | gstr2b-vs-books | client, month | `GSTR2B_vs_Books_<Client>_<YYYY-MM>.xlsx` |
| 26AS/AIS vs books | ais-26as-vs-books | client, FY | `TDS_Credit_Reco_<Client>_<FY>.xlsx` |
| Ledger scrutiny | ledger-scrutiny | client, FY, ledgers | `Scrutiny_<Client>_<FY>.xlsx` |
| Draft notice reply | notice-reply-draft, word | notice PDF | `NoticeReply_<Client>_<date>.docx` |
| Missing documents | doc-chaser | period | `MissingDocs_<period>.xlsx` |
| Month-end MIS | tally-mis | client, month | `MIS_<Client>_<YYYY-MM>.xlsx` |
| Purchase bills to vouchers | pdf/ocr, tally-post | folder of bills | Review queue items |
| Summarise a document | pdf, summarize | file | Summary in chat + `.md` next to file |
| Due this week | compliance-calendar | none | List in chat |

Role defaults: Article = bank reco, 2B, scrutiny, missing docs, summarise. Senior/Manager = all. Partner = due this week, summaries, MIS, digest.
