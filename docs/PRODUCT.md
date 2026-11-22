# Product

## 1. One line

An AI assistant for every employee of an Indian CA firm, running on the firm's own Windows RDS server, that can read and prepare work in Excel, Word, PDFs and Tally within the employee's existing file rights, and that Off Manual installs, vets and maintains under AMC.

## 2. Why firms buy it

- Microsoft 365 Copilot Business lists at ₹1,745 per user per month in India (GST extra) and lives inside Office apps. It doesn't post Tally vouchers, know GSTR due dates, or read 26AS/AIS. Off Manual Desk does CA-firm work, on the firm's server, under the firm's permissions.
- No new permission system to learn: whatever an employee can open in Windows, the assistant can; whatever they can't, it can't.
- Off Manual vets every skill. ClawHub skills are never installed directly.

## 3. People

| Person | Typical role | Wants | Must never have to |
| --- | --- | --- | --- |
| Employee | Article assistant, semi-qualified, accountant | Finish routine work faster: recos, scrutiny, drafts, data entry | Learn prompting, type file paths, read error codes |
| Partner | CA, owner | Faster turnaround, fewer mistakes, visibility, confidentiality | Babysit the tool |
| Firm admin | Office manager or IT person | Add/remove people, set rules, see what's happening | Edit config files, call Off Manual for routine changes |
| Off Manual (Dwahnil) | Seller, installer, maintainer | Install a firm in under two hours, ship updates safely, bill without chasing | Remote into servers for routine tasks |

## 4. Ease-of-use rules (every screen must pass these)

1. **Meet them where they work.** Desk is a panel docked to the screen edge, opened with one hotkey (default `Ctrl+Space`, configurable), and reachable by right-clicking any file or folder ("Ask Off Manual").
2. **Clients, not paths.** People say "Mehta Traders FY2025-26". The client directory maps names to folder, Tally company, GSTIN, PAN and partner.
3. **Buttons before blank boxes.** Each role sees 10–15 one-click tasks with client and period pickers. Free chat remains for everything else.
4. **Results are files.** Every task ends as a file saved in the client's folder with a standard name (`<Task>_<Client>_<Period>.xlsx`) plus a three-line summary. Nothing important lives only in chat.
5. **Ask once, approve in batches.** One code a day; PIN after idle; review 30 proposed vouchers on one screen.
6. **Every "no" has a next step.** Blocks come with a *Request access* button that pre-fills a note to the admin.
7. **Plain words.** No stack traces, no tool names, no JSON in the UI. Errors say what happened, why, and what to do.
8. **Indian conventions.** ₹ with Indian digit grouping (1,23,456), DD-MM-YYYY, "FY2025-26", GSTIN/PAN formats.

## 5. The employee's day (acceptance scenarios)

| Moment | Employee does | Desk does |
| --- | --- | --- |
| Logs into RDP | Enters 6-digit code once a day | Unlocks for the firm's working day; PIN after any idle lock |
| Needs a bank reco | Clicks *Bank reco*, picks client and month | Finds the statement in the client folder, pulls the ledger from Tally, saves `BankReco_<Client>_<YYYY-MM>.xlsx` next to the statement, lists unmatched items |
| Has a scanned bill | Right-clicks PDF → *Ask Off Manual* | Reads it, proposes a purchase voucher, puts it in the review queue |
| End of day | Opens *Review* | Approves 18 at once, edits 2, rejects 1; each posted voucher read back from Tally |
| On the train | Messages the firm Telegram bot | "Which clients haven't sent October bank statements?" Text answer; files stay on the server |
| Folder they can't open | Sees "You are not authorised to open Clients\Mehta Traders" | Taps *Request access*; admin gets a pre-filled note |

## 6. Feature list

| Feature | For | Version |
| --- | --- | --- |
| Docked panel, hotkey, Explorer right-click | Employee | v1 |
| Client directory (built by Admin agent scanning the Clients share and Tally company list; editable) | Employee, admin | v1 |
| Task buttons per role with client and period pickers (SKILLS.md §5) | Employee | v1 |
| Review queue: approve all / edit / reject per row, before–after view, read-back result | Employee, partner | v1 |
| Daily code + PIN + step-up | Employee | v1 |
| Firm Telegram bot, one-tap linking, Telegram unlock | Employee | v1 |
| Request access on every denial | Employee, admin | v1 |
| Report a problem (logs metadata + optional screenshot after preview) | Everyone | v1 |
| Update notice + Restart to update | Employee | v1 |
| Billing banners for firm admin | Firm admin | v1 |
| Admin agent (chat to manage people, packs, policies, see audit, explain folder rights) | Firm admin | v1 |
| Setup wizard: pre-flight, import users from AD group, invites by email/WhatsApp, client scan | Firm admin, Off Manual | v1 |
| Weekly partner digest: tasks done, estimated hours saved, access requests, LLM spend | Partner | v1 |
| Fleet board (servers red/amber/green, versions, failed updates, seats, overdue invoices) | Off Manual | v1 |
| Hindi / Marathi / Gujarati chat; Telegram voice notes transcribed | Employee | v2 |
| Excel and Outlook add-ins | Employee | v2 |
| WhatsApp Business document-chasing reminders to clients | Employee | v2 |

## 7. Targets for the pilot

- One server from blank to live: under 2 hours of Off Manual's time.
- Employee first finished task: within 10 minutes of first login.
- Zero client files sent to Telegram or Off Manual's cloud.
- Measured: hours saved per employee per week, tokens per seat per month.

## 8. Glossary

- **Gateway**: the OpenClaw process that runs one employee's agent.
- **Skill pack**: a named set of skills and allowed actions (e.g. `Tally-post`), granted via AD group or console.
- **Review queue**: where proposed irreversible actions wait for a human.
- **Server Agent**: Off Manual's Windows service on the firm's server.
- **Ring**: rollout group for releases (0 lab, 1 pilot, 2 all).
- **AMC**: annual maintenance contract.
