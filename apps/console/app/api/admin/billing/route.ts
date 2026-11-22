import { adminHandler } from "@/lib/admin-routes";
import { billingAction } from "@/lib/billing/admin";
import { paymentLinksFromEnv } from "@/lib/billing/razorpay";
import { billingConfigFromEnv } from "@/lib/billing/run";
import { routeDeps } from "@/lib/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  const d = routeDeps();
  return adminHandler(d, req, (s, body) =>
    billingAction({ ...d, links: paymentLinksFromEnv() }, billingConfigFromEnv(), s, body),
  );
}
