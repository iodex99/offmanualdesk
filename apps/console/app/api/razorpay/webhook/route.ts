import { razorpayWebhook } from "@/lib/billing/razorpay";
import { getDb } from "@/lib/db";
import { mailerFromEnv } from "@/lib/email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Razorpay webhook (payment_link.paid). Configure the URL and RAZORPAY_WEBHOOK_SECRET in the Razorpay dashboard (ADR-065). */
export function POST(req: Request): Promise<Response> {
  return razorpayWebhook(
    { db: getDb(), now: () => new Date(), mailer: mailerFromEnv() },
    process.env.RAZORPAY_WEBHOOK_SECRET,
    req,
  );
}
