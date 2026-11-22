// Outgoing email (invites now; invoices and notices later). Resend's send API,
// verified 2026-11-23 at resend.com/docs/api-reference/emails/send-email:
// POST https://api.resend.com/emails, `Authorization: Bearer <key>`, JSON
// { from, to, subject, text }, optional `Idempotency-Key` header (≤ 256 chars,
// 24 h); success 200 { id }. The error body isn't documented, so only the status
// is used. Emails carry no client data (rule 10): names and links only.

export interface Email {
  to: string;
  subject: string;
  text: string;
  /** Same key → Resend sends once (retries are safe). */
  idempotencyKey: string;
}

export interface Mailer {
  /** Resolves when accepted; throws MailError otherwise. */
  send(m: Email): Promise<void>;
}

export class MailError extends Error {
  constructor(readonly status: number) {
    super(`email not accepted (HTTP ${status})`);
  }
}

export const RESEND_URL = "https://api.resend.com/emails";

export function resendMailer(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): Mailer {
  return {
    async send(m) {
      const res = await fetchImpl(RESEND_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "idempotency-key": m.idempotencyKey.slice(0, 256),
        },
        body: JSON.stringify({ from, to: m.to, subject: m.subject, text: m.text }),
      });
      if (!res.ok) throw new MailError(res.status);
    },
  };
}

/** The mailer from env, or null when email isn't configured yet. */
export function mailerFromEnv(env: Record<string, string | undefined> = process.env): Mailer | null {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.OM_EMAIL_FROM?.trim();
  return key && from ? resendMailer(key, from) : null;
}

/** The invite an employee gets when their admin adds them (ARCHITECTURE F2). */
export function inviteEmail(p: {
  to: string;
  name: string;
  firm: string;
  consoleUrl: string;
  inviteId: string;
}): Email {
  const bind = `${p.consoleUrl.replace(/\/+$/, "")}/bind`;
  return {
    to: p.to,
    subject: `${p.firm} has set you up on Off Manual`,
    text: [
      `Hello ${p.name},`,
      "",
      `${p.firm} uses Off Manual, an assistant that works with your office files.`,
      "",
      "To start:",
      "1. Sign in to your work computer (the office server) as usual. Off Manual Desk opens by itself.",
      `2. Choose "Sign in to get started" and sign in with this email (${p.to}). You can also open ${bind}`,
      "3. Type the code it shows into Off Manual Desk, then set up your authenticator app.",
      "",
      "If you weren't expecting this, ignore this email or tell your firm's admin.",
      "",
      "Off Manual",
    ].join("\n"),
    idempotencyKey: `invite-${p.inviteId}`,
  };
}
