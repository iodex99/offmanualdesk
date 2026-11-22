# Off Manual Desk: quick start for employees

Off Manual is an assistant that works with your office files and Tally, on your firm's own server. It only
opens what your Windows account can open, and anything that can't be undone waits for a person to approve it.

## First day (about 5 minutes)

1. **Sign in to the office server** as usual. Off Manual Desk opens by itself.
2. **Sign in to get started.** Desk shows a web address and a QR code. Open it (on this computer or your phone),
   sign in with your **work** Google or Microsoft account, and type the code it shows into Desk.
3. **Set up your authenticator app.** Scan the QR code with Google Authenticator or Microsoft Authenticator and
   type the 6-digit code.
4. **Write down your recovery codes.** Desk shows 8 codes once. Keep them somewhere safe, not on the office
   computer. If you lose your phone, one code lets you set up a new one.
5. **Choose a PIN** (4 to 8 digits). You'll use it after a break.

## Every day

- The first time you open Desk each day, type **today's code** from your authenticator app.
- After a break, Desk locks itself. Unlock with your **PIN**. Three wrong PINs and it asks for today's code.
- **Lock now** locks Desk straight away when you leave your desk.

## What you can do

| Tab | What it's for |
| --- | --- |
| **Chat** | Ask anything about your clients' files: "Which Mehta Traders bank statements do we have for FY2025-26?" Replies appear as they're written; **Stop** ends a long answer. |
| **Tasks** | One-click jobs: GSTR-2B vs books, 26AS/AIS vs books, ledger scrutiny, notice reply draft, missing documents, month-end MIS, bank reco, summarise a document, build client list, due this week. Pick the client and period; the result is saved as a file in the client's folder. |
| **Review** | Anything that can't be undone (today: deleting files) waits here. **Approve**, **Edit** (untick files to keep), **Reject**, or **Approve all**. Your firm may ask for today's code before approving. |
| **Telegram** | Link your phone's Telegram once (scan the QR code, press Start). Then you can message your assistant from your phone while you're signed in to the office server. Text only; files stay on the server. |
| **Report a problem** | Tell us what went wrong in a few words. Desk shows exactly what it sends with your note (versions and server checks, never your files or chats) and gives you a reference number. |

## Good to know

- **Files stay in the office.** Your files, chats and prompts never go to Off Manual. Only numbers (how many
  questions, which version) do.
- **Ask about a file or folder**: right-click it in Explorer → **Ask Off Manual**. Desk comes forward with the
  path in the message box; finish your question and press Send.
- **"You are not authorised to open …"** means your Windows account can't open that folder. Off Manual won't look
  for another copy. Click **Request access** under the reply, say in a few words why you need it, and send. Your
  admin sees it in their Desk; the **Access** tab shows you the answer.
- **Don't put client details in a problem report.** We don't need names, PAN or amounts to help.
- **Updates.** When Desk says "Off Manual … is ready. Restart to update", click it when it suits you; your
  assistant restarts for a few seconds. If an update ever fails, Desk goes back to the previous version by itself.
- **Your assistant rests** after a few unused hours to save the server's memory. Your next message starts it
  again.

## Lost your phone?

On the unlock screen choose **Lost your phone?** and type one of your recovery codes. Then set up your
authenticator again. If you've also lost the recovery codes, ask your firm's admin to **reset your
authenticator**.

## Telegram commands

- Send any question as a normal message.
- `/unlock 123456` (today's code) unlocks Telegram for a while when Desk is locked.
