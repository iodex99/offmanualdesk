# Off Manual: guide for firm admins

You manage your firm's people, settings and invoices in the Off Manual console. Sign in with your work Google or
Microsoft account; the console always asks for your authenticator code too.

## Your firm's page

### Employees

- **Add an employee**: name and work email. If email is set up, they get an invite with the steps.
- **Add many people at once**: paste one person per line, `Name, email` (you can copy two columns from Excel).
  Lines that can't be added are listed with the reason; the rest are added.
- **Send invite again** for anyone who hasn't signed in yet.
- **Switch off** someone who has left. Their Off Manual stops on the next server sync (within 15 minutes), their
  Telegram link is removed and their assistant can't start again. About 15 minutes later their assistant's own
  data (chats and memory, not your files) is moved from their Windows profile into an archive on the server that
  only administrators can open, and deleted after the number of days you set to keep it. Switch them on again
  before then and nothing is moved. Nothing is deleted from your file server.
- **Reset authenticator** only when someone has lost both their phone and their recovery codes. They set it up
  again in Desk from their own Windows sign-in.

### Skill packs

Packs decide what each person's assistant can do. **Core** is for everyone. Give other packs (for example
Tally read) to one employee or to everyone in an AD group whose name starts with `OM-`.

### Settings

| Setting | What it does |
| --- | --- |
| Lock after idle | Desk locks after this many minutes without keyboard or mouse use. |
| Working day ends at | Today's code is needed again after this hour (IST). |
| Telegram | Off, text only, or text and files. |
| Telegram unlock lasts | How long `/unlock` keeps Telegram usable while Desk is locked. |
| Stop an unused assistant after | Saves server memory; the next message starts it again. |
| Keep a departed employee's data | Days to keep their assistant data after they're switched off. |
| Ask for today's code before approving | Approving review items needs a fresh authenticator code. |

Changes reach your server within 15 minutes.

### Notices

Post a short message that appears in everyone's Desk (or only the firm admins'). Billing reminders from
Off Manual appear for firm admins automatically.

### Servers

Each server shows whether it's healthy and what its setup checks found, with the fix for anything that needs
attention.

### Invoices

Download any issued invoice as a PDF. You also get an email when an invoice is issued, a week before it's due,
on the due date and if it becomes overdue, plus a Monday summary of how your firm used Off Manual.

## Access requests

When someone's assistant is refused a folder, they can send you a request from Desk. If you're a firm admin,
open the **Access** tab in your own Desk: it lists who asked, which folder and why. Off Manual never changes
folder rights: give access in Windows (folder Properties → Security, or your usual AD group), then click
**Done**, or **Decline**. Requests stay on your server; Off Manual's cloud never sees the folder names.

## What Off Manual can and can't see

- It works **as each employee's Windows account**, so it can only open what that person can open on your file
  server. It never tries another way in when Windows says no.
- **Nothing about your clients leaves your server**: no file contents, file names, chats or prompts. The console
  receives counts (questions asked, active people), versions and health.
- Anything that can't be undone (deleting files today; posting to Tally and sending client emails when those
  packs arrive) waits in the employee's **Review** tab for a person to approve.
- Government portal steps that need an OTP or a DSC always stay with a person.

## If the service pauses

If an invoice stays unpaid well past its due date, Desk first shows a notice, then pauses for employees until
it's paid. Your data stays on your server. Contact Off Manual if something looks wrong.
