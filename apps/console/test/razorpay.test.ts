// Razorpay payment links and webhook (ADR-065) against PGlite and a fake Razorpay.
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { firms, invoices, payments } from "@/db/schema";
import { listInvoices } from "@/lib/billing/admin";
import {
  ensurePaymentLinks,
  paymentLinksFromEnv,
  razorpayLinks,
  razorpayWebhook,
  RazorpayError,
  signatureOk,
  type PaymentLinks,
} from "@/lib/billing/razorpay";
import type { SessionState } from "@/lib/auth";
import type { DB } from "@/lib/db";
import { uuidv7 } from "@/lib/ids";
import { testDb } from "./helpers/db";

let db: DB;
let close: () => Promise<void>;
const now = new Date("2026-12-01T05:00:00Z");
const deps = () => ({ db, now: () => now });
let firmId: string;
const WEBHOOK_SECRET = "test-webhook-secret-not-real";

beforeEach(async () => {
  ({ db, close } = await testDb());
  firmId = uuidv7();
  await db.insert(firms).values({
    id: firmId,
    name: "Mehta & Co",
    legalName: "Mehta & Co LLP",
    stateCode: "27",
    billingEmail: "accounts@mehta.in",
    status: "overdue",
  });
});
afterEach(async () => close());

async function invoice(status: "draft" | "issued" | "paid", number: string | null = "OM/FY2026-27/0001") {
  const id = uuidv7();
  await db.insert(invoices).values({
    id,
    firmId,
    number,
    periodStart: `2026-${String(10 + (number ? Number(number.slice(-1)) : 0)).padStart(2, "0")}-01`,
    periodEnd: "2026-11-30",
    issuedOn: status === "draft" ? null : "2026-12-01",
    dueOn: status === "draft" ? null : "2026-12-16",
    taxablePaise: 200000n,
    cgstPaise: 18000n,
    sgstPaise: 18000n,
    igstPaise: 0n,
    totalPaise: 236000n,
    status,
  });
  return id;
}

function fakeRazorpay(reply: (body: Record<string, unknown>) => { status: number; body: unknown }) {
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body });
    const r = reply(body);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { f, calls };
}

describe("payment link client", () => {
  it("sends the verified request shape with Basic auth", async () => {
    const { f, calls } = fakeRazorpay(() => ({
      status: 200,
      body: { id: "plink_ERgihyaAAC0VNW", short_url: "https://rzp.io/rzp/abc", status: "created" },
    }));
    const links = razorpayLinks("rzp_test_key", "secret-value", f);
    const out = await links.create({
      invoiceId: "inv-1",
      number: "OM/FY2026-27/0001",
      amountPaise: 236000n,
      firmName: "Mehta & Co",
      email: "accounts@mehta.in",
    });
    expect(out).toEqual({ id: "plink_ERgihyaAAC0VNW", url: "https://rzp.io/rzp/abc" });
    expect(calls[0]!.url).toBe("https://api.razorpay.com/v1/payment_links/");
    expect(calls[0]!.auth).toBe("Basic " + Buffer.from("rzp_test_key:secret-value").toString("base64"));
    expect(calls[0]!.body).toEqual({
      amount: 236000,
      currency: "INR",
      accept_partial: false,
      reference_id: "OM/FY2026-27/0001",
      description: "Off Manual invoice OM/FY2026-27/0001",
      customer: { name: "Mehta & Co", email: "accounts@mehta.in" },
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { invoice_id: "inv-1" },
    });
  });

  it("errors carry the status and Razorpay's code, never the key", async () => {
    const { f } = fakeRazorpay(() => ({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST_ERROR",
          description: "payment link creation with reference ID already attempted",
        },
      },
    }));
    const links = razorpayLinks("rzp_test_key", "secret-value", f);
    const err = await links
      .create({ invoiceId: "i", number: "OM/1", amountPaise: 1000n, firmName: "F", email: "a@b.in" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RazorpayError);
    expect(String((err as Error).message)).toBe("Razorpay 400 BAD_REQUEST_ERROR");
    expect(String((err as Error).message)).not.toContain("secret-value");
    const bad = fakeRazorpay(() => ({ status: 200, body: { id: "x", short_url: 1 } }));
    await expect(
      razorpayLinks("k", "s", bad.f).create({
        invoiceId: "i",
        number: "OM/1",
        amountPaise: 1000n,
        firmName: "F",
        email: "a@b.in",
      }),
    ).rejects.toThrow(/UNEXPECTED_RESPONSE/);
  });

  it("refuses amounts under ₹1 and references over 40 characters before calling", async () => {
    const { f, calls } = fakeRazorpay(() => ({ status: 200, body: {} }));
    const links = razorpayLinks("k", "s", f);
    const base = { invoiceId: "i", firmName: "F", email: "a@b.in" };
    await expect(links.create({ ...base, number: "OM/1", amountPaise: 99n })).rejects.toThrow();
    await expect(links.create({ ...base, number: "X".repeat(41), amountPaise: 1000n })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("is off until both keys are set", () => {
    const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;
    expect(paymentLinksFromEnv(env({}))).toBeNull();
    expect(paymentLinksFromEnv(env({ RAZORPAY_KEY_ID: "rzp_test_x" }))).toBeNull();
    expect(
      paymentLinksFromEnv(env({ RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "s" })),
    ).not.toBeNull();
  });
});

describe("ensurePaymentLinks", () => {
  it("links issued invoices once; drafts and paid ones never; failures retried later", async () => {
    const issued = await invoice("issued", "OM/FY2026-27/0001");
    await invoice("draft", null);
    await invoice("paid", "OM/FY2026-27/0002");
    let fail = true;
    const made: string[] = [];
    const links: PaymentLinks = {
      async create(i) {
        if (fail) throw new Error("razorpay down");
        made.push(i.number);
        return { id: `plink_${made.length}`, url: `https://rzp.io/rzp/${made.length}` };
      },
    };
    expect(await ensurePaymentLinks(deps(), links)).toBe(0); // down: nothing recorded
    expect((await db.select().from(invoices).where(eq(invoices.id, issued)))[0]!.paymentLinkId).toBeNull();
    fail = false;
    expect(await ensurePaymentLinks(deps(), links)).toBe(1);
    expect(await ensurePaymentLinks(deps(), links)).toBe(0); // already linked
    expect(made).toEqual(["OM/FY2026-27/0001"]);
    expect(await ensurePaymentLinks(deps(), null)).toBe(0); // not configured
    // Firm admins see the link on their invoice list.
    const admin: SessionState = {
      principal: {
        kind: "firm_admin",
        userId: uuidv7(),
        email: "p@mehta.in",
        name: "P",
        firmId,
        role: "owner",
      },
      mfa: true,
      token: "t",
    } as SessionState;
    const list = await listInvoices(deps(), admin, firmId);
    expect(list.invoices.find((i) => i.id === issued)?.paymentLinkUrl).toBe("https://rzp.io/rzp/1");
  });
});

describe("webhook", () => {
  const sign = (raw: string, secret = WEBHOOK_SECRET) =>
    createHmac("sha256", secret).update(raw).digest("hex");
  const post = (raw: string, sig: string | null) =>
    razorpayWebhook(
      deps(),
      WEBHOOK_SECRET,
      new Request("https://console.test/api/razorpay/webhook", {
        method: "POST",
        headers: sig ? { "x-razorpay-signature": sig } : {},
        body: raw,
      }),
    );
  const paid = (linkId: string, payId: string, amount = 236000, status = "captured") =>
    JSON.stringify({
      entity: "event",
      event: "payment_link.paid",
      created_at: 1764567000,
      payload: {
        payment_link: { entity: { id: linkId, status: "paid", amount, amount_paid: amount } },
        payment: { entity: { id: payId, amount, currency: "INR", status, method: "upi" } },
        order: { entity: { id: "abc", notes: [] } },
      },
    });

  it("checks the signature over the raw body", async () => {
    const raw = paid("plink_1", "pay_1");
    expect((await post(raw, null)).status).toBe(401);
    expect((await post(raw, sign(raw, "other-secret"))).status).toBe(401);
    expect((await post(raw, "zz")).status).toBe(401);
    expect((await post(raw + " ", sign(raw))).status).toBe(401); // body changed after signing
    expect(signatureOk(raw, sign(raw), undefined)).toBe(false); // no secret configured: refuse everything
    expect(signatureOk(raw, sign(raw), WEBHOOK_SECRET)).toBe(true);
  });

  it("records a paid link once, marks the invoice paid and restores the firm", async () => {
    const id = await invoice("issued");
    await db.update(invoices).set({ paymentLinkId: "plink_1" }).where(eq(invoices.id, id));
    const raw = paid("plink_1", "pay_ABC123");
    const r = await post(raw, sign(raw));
    expect(await r.json()).toEqual({ recorded: true });
    expect((await db.select().from(invoices).where(eq(invoices.id, id)))[0]!.status).toBe("paid");
    const p = await db.select().from(payments).where(eq(payments.invoiceId, id));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({
      provider: "razorpay",
      providerRef: "pay_ABC123",
      amountPaise: 236000n,
      method: "upi",
    });
    expect(p[0]!.paidAt.toISOString()).toBe(new Date(1764567000 * 1000).toISOString());
    // At-least-once delivery: the same event again changes nothing.
    expect(await (await post(raw, sign(raw))).json()).toEqual({ duplicate: true });
    expect(await db.select().from(payments).where(eq(payments.invoiceId, id))).toHaveLength(1);
  });

  it("acknowledges events it doesn't act on", async () => {
    const id = await invoice("issued");
    await db.update(invoices).set({ paymentLinkId: "plink_1" }).where(eq(invoices.id, id));
    const cases = [
      JSON.stringify({
        event: "payment_link.expired",
        payload: { payment_link: { entity: { id: "plink_1" } } },
      }),
      paid("plink_unknown", "pay_1"), // not ours
      paid("plink_1", "pay_2", 236000, "failed"), // not captured
      paid("plink_1", "not-a-pay-id"),
    ];
    for (const raw of cases) expect(await (await post(raw, sign(raw))).json()).toEqual({ ignored: true });
    expect(await db.select().from(payments)).toHaveLength(0);
    expect((await post("not json", sign("not json"))).status).toBe(400);
  });
});
