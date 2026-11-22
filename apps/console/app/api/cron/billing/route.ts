import { dailyBilling } from "@/lib/billing/cron";
import { billingConfigFromEnv } from "@/lib/billing/run";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request): Promise<Response> {
  return dailyBilling(
    { db: getDb(), now: () => new Date() },
    billingConfigFromEnv(),
    process.env.CRON_SECRET,
    req,
  );
}
