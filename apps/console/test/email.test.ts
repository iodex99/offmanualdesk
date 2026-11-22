import { describe, expect, it } from "vitest";
import { inviteEmail, MailError, mailerFromEnv, RESEND_URL, resendMailer } from "@/lib/email";

describe("Resend mailer", () => {
  it("posts the documented request and succeeds on 200", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "e-1" }), { status: 200 });
    }) as unknown as typeof fetch;
    await resendMailer("re_test", "Off Manual <noreply@offmanual.in>", fake).send({
      to: "asha@mehta.in",
      subject: "S",
      text: "T",
      idempotencyKey: "invite-1",
    });
    expect(calls[0]!.url).toBe(RESEND_URL);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer re_test");
    expect(h["idempotency-key"]).toBe("invite-1");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      from: "Off Manual <noreply@offmanual.in>",
      to: "asha@mehta.in",
      subject: "S",
      text: "T",
    });
  });

  it("throws MailError with the status otherwise", async () => {
    const fake = (async () => new Response("{}", { status: 422 })) as unknown as typeof fetch;
    await expect(
      resendMailer("k", "f", fake).send({ to: "a@b.in", subject: "s", text: "t", idempotencyKey: "x" }),
    ).rejects.toMatchObject({
      status: 422,
    });
    expect(new MailError(403).message).not.toContain("k");
  });

  it("is off until both the key and the sender are configured", () => {
    expect(mailerFromEnv({})).toBeNull();
    expect(mailerFromEnv({ RESEND_API_KEY: "re_x" })).toBeNull();
    expect(mailerFromEnv({ RESEND_API_KEY: "re_x", OM_EMAIL_FROM: "a <b@c.in>" })).not.toBeNull();
  });

  it("the invite has the bind link and no client data", () => {
    const m = inviteEmail({
      to: "asha@mehta.in",
      name: "Asha",
      firm: "Mehta & Co",
      consoleUrl: "https://console.offmanual.in/",
      inviteId: "i-1",
    });
    expect(m.subject).toBe("Mehta & Co has set you up on Off Manual");
    expect(m.text).toContain("https://console.offmanual.in/bind");
    expect(m.text).toContain("Hello Asha,");
    expect(m.idempotencyKey).toBe("invite-i-1");
  });
});
