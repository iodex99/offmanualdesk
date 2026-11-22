// Razorpay payment links and webhook (BILLING §5, ADR-065). API facts verified in
// Razorpay's docs (api/payments/payment-links/create-standard, webhooks/payment-links,
// webhooks/validate-test, webhooks/best-practices, api/authentication) and razorpay-node
// v2.9.8 (lib/utils/razorpay-utils.js: hex HMAC-SHA256 of the raw body).
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { firms, invoices } from "@/db/schema";
import { isUniqueViolation } from "../admin";
import { emailReceipts } from "../admin-mail";
import type { Mailer } from "../email";
import { billingNotices } from "../notices";
import { BillingError, recordPayment, refreshFirmStatus, type BillingDeps } from "./run";

const API = "https://api.razorpay.com/v1";

export interface PaymentLinkInput {
  invoiceId: string;
  /** Invoice number: the link's reference_id (unique per Razorpay account, ≤ 40 chars). */
  number: string;
  amountPaise: bigint;
  firmName: string;
  email: string;
}

export interface PaymentLinks {
  create(input: PaymentLinkInput): Promise<{ id: string; url: string }>;
}

export class RazorpayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Razorpay ${status}${code ? ` ${code}` : ""}`); // never the key or the request body
  }
}

/** The Razorpay client, or null until RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set. */
export function paymentLinksFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): PaymentLinks | null {
  const keyId = env.RAZORPAY_KEY_ID?.trim();
  const secret = env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !secret) return null;
  return razorpayLinks(keyId, secret, fetchImpl);
}

export function razorpayLinks(keyId: string, secret: string, fetchImpl: typeof fetch = fetch): PaymentLinks {
  const auth = "Basic " + Buffer.from(`${keyId}:${secret}`).toString("base64"); // exact casing "Basic"
  return {
    async create(i) {
      // INR minimum is 100 paise; amounts are whole paise and must fit a JSON number.
      if (i.amountPaise < 100n || i.amountPaise > BigInt(Number.MAX_SAFE_INTEGER))
        throw new BillingError("amount can't be paid by link");
      if (i.number.length === 0 || i.number.length > 40) throw new BillingError("reference too long");
      const res = await fetchImpl(`${API}/payment_links/`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({
          amount: Number(i.amountPaise),
          currency: "INR",
          accept_partial: false,
          reference_id: i.number,
          description: `Off Manual invoice ${i.number}`.slice(0, 2048),
          customer: { name: i.firmName.slice(0, 120), email: i.email },
          // Off Manual sends its own notices and emails (ADR-052/053).
          notify: { sms: false, email: false },
          reminder_enable: false,
          notes: { invoice_id: i.invoiceId },
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        id?: unknown;
        short_url?: unknown;
        error?: { code?: unknown };
      };
      if (res.status !== 200) {
        throw new RazorpayError(res.status, typeof body.error?.code === "string" ? body.error.code : "");
      }
      if (typeof body.id !== "string" || !body.id.startsWith("plink_") || typeof body.short_url !== "string")
        throw new RazorpayError(res.status, "UNEXPECTED_RESPONSE");
      return { id: body.id, url: body.short_url };
    },
  };
}

/**
 * Makes payment links for issued invoices that don't have one yet (all, or one invoice).
 * Failures are left for the next run (the daily cron retries); returns how many were made.
 */
export async function ensurePaymentLinks(
  deps: BillingDeps,
  links: PaymentLinks | null,
  invoiceId?: string,
): Promise<number> {
  if (!links) return 0;
  const rows = await deps.db
    .select({
      id: invoices.id,
      number: invoices.number,
      total: invoices.totalPaise,
      firmName: firms.name,
      email: firms.billingEmail,
    })
    .from(invoices)
    .innerJoin(firms, eq(firms.id, invoices.firmId))
    .where(
      and(
        eq(invoices.status, "issued"),
        isNull(invoices.paymentLinkId),
        ...(invoiceId ? [eq(invoices.id, invoiceId)] : []),
      ),
    );
  let made = 0;
  for (const r of rows) {
    if (!r.number) continue;
    try {
      const link = await links.create({
        invoiceId: r.id,
        number: r.number,
        amountPaise: r.total,
        firmName: r.firmName,
        email: r.email,
      });
      await deps.db
        .update(invoices)
        .set({ paymentLinkId: link.id, paymentLinkUrl: link.url, updatedAt: deps.now() })
        .where(and(eq(invoices.id, r.id), isNull(invoices.paymentLinkId)));
      made++;
    } catch {
      // Not fatal: the invoice stays payable by bank transfer; retried tomorrow.
    }
  }
  return made;
}

/** X-Razorpay-Signature: hex HMAC-SHA256 of the raw body with the webhook secret. */
export function signatureOk(rawBody: string, header: string | null, secret: string | undefined): boolean {
  if (!secret || !header || !/^[0-9a-f]{64}$/.test(header)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(header, "hex"));
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

interface PaidEvent {
  event?: unknown;
  created_at?: unknown;
  payload?: {
    payment_link?: { entity?: { id?: unknown; status?: unknown } };
    payment?: { entity?: { id?: unknown; amount?: unknown; status?: unknown; method?: unknown } };
  };
}

/**
 * POST /api/razorpay/webhook. Verifies the signature over the raw body before parsing.
 * Only `payment_link.paid` records a payment; everything else is acknowledged. Razorpay
 * delivers at least once: the same payment id is recorded once (unique index).
 */
export async function razorpayWebhook(
  deps: BillingDeps & { mailer?: Mailer | null },
  secret: string | undefined,
  req: Request,
) {
  const raw = await req.text();
  if (raw.length > 256 * 1024) return json(413, { error: "too large" });
  if (!signatureOk(raw, req.headers.get("x-razorpay-signature"), secret))
    return json(401, { error: "bad signature" });
  let ev: PaidEvent;
  try {
    ev = JSON.parse(raw) as PaidEvent;
  } catch {
    return json(400, { error: "not json" });
  }
  if (ev.event !== "payment_link.paid") return json(200, { ignored: true });
  const linkId = ev.payload?.payment_link?.entity?.id;
  const pay = ev.payload?.payment?.entity;
  if (
    typeof linkId !== "string" ||
    typeof pay?.id !== "string" ||
    !/^pay_[A-Za-z0-9]{1,40}$/.test(pay.id) ||
    typeof pay.amount !== "number" ||
    !Number.isSafeInteger(pay.amount) ||
    pay.amount <= 0 ||
    pay.status !== "captured"
  )
    return json(200, { ignored: true });
  const inv = (
    await deps.db
      .select({ id: invoices.id, firmId: invoices.firmId })
      .from(invoices)
      .where(eq(invoices.paymentLinkId, linkId))
  )[0];
  if (!inv) return json(200, { ignored: true }); // not one of ours (or another environment's)
  const paidAt =
    typeof ev.created_at === "number" && Number.isSafeInteger(ev.created_at)
      ? new Date(ev.created_at * 1000)
      : deps.now();
  try {
    await recordPayment(deps, {
      invoiceId: inv.id,
      amountPaise: BigInt(pay.amount),
      paidAt,
      provider: "razorpay",
      providerRef: pay.id,
      ...(typeof pay.method === "string" ? { method: pay.method.slice(0, 40) } : {}),
    });
  } catch (e) {
    if (isUniqueViolation(e)) return json(200, { duplicate: true });
    if (e instanceof BillingError) return json(200, { ignored: true }); // e.g. invoice voided
    throw e;
  }
  await billingNotices(deps); // a paid invoice ends its notices (ADR-052)
  await refreshFirmStatus(deps, inv.firmId); // paying restores the firm (BILLING §6)
  await emailReceipts(deps); // receipt to the firm's admins (ADR-067)
  return json(200, { recorded: true });
}
