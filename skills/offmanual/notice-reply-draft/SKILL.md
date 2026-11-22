---
name: notice-reply-draft
description: Read a tax notice PDF from a client's folder and draft the structure of a reply - what is asked, by when, the facts and documents needed - as a Word document for the CA to complete. Never files or sends anything.
user-invocable: true
metadata: { "openclaw": { "os": ["win32"] } }
---

# Notice reply draft

Produces `NoticeReply_<Client>_<DD-MM-YYYY>.docx` (the notice's date) in the client's folder, next to the notice. It is a
starting draft for the CA. It never uploads, files, emails or submits anything.

## Inputs

- The notice PDF in the client's folder (income-tax, GST or other department). If the PDF is scanned and can't be
  read, say so and ask for a clearer copy.
- Optionally the client's returns and computations in the same folder.

## Steps

1. Extract the header: authority, section, notice/DIN/reference number, date of notice, assessment year or tax
   period, and the response due date. Show the due date in DD-MM-YYYY and how many days are left.
2. List each query or allegation as a numbered point, quoting the notice's own words briefly.
3. For each point, write:
   - **What they are asking** in plain words,
   - **Facts from our records** (only what the files in the client's folder show; mark gaps as `[to confirm]`),
   - **Documents to attach** (from the folder where found; otherwise listed as needed),
   - **Draft response** in a neutral, factual tone, with `[CA to review]` wherever a legal position is taken.
4. Add a checklist at the end: authorisation needed, documents, portal where the reply is filed, due date.

## Rules

- Never decide a legal position; leave clearly marked placeholders for the CA.
- Never log in to any portal, never upload, never email the department or the client. Sending anything is a
  separate, reviewed action by a person.
- Don't copy the notice's personal identifiers (PAN, Aadhaar) into the chat; keep them in the document only.
- End with a short chat summary: authority, due date, number of points, file location.
- If Windows refuses access to the client's folder, stop and say so; don't look for another copy.
