import { dailyBilling } from "@/lib/billing/cron";
import { paymentLinksFromEnv } from "@/lib/billing/razorpay";
import { billingConfigFromEnv } from "@/lib/billing/run";
import { getDb } from "@/lib/db";
import { mailerFromEnv } from "@/lib/email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request): Promise<Response> {
  return dailyBilling(
    { db: getDb(), now: () => new Date(), mailer: mailerFromEnv(), links: paymentLinksFromEnv() },
    billingConfigFromEnv(),
    process.env.CRON_SECRET,
    req,
  );
}
