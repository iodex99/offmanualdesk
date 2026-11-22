import { adminHandler } from "@/lib/admin-routes";
import { listInvoices } from "@/lib/billing/admin";
import { routeDeps } from "@/lib/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ firmId: string }> }): Promise<Response> {
  const d = routeDeps();
  const { firmId } = await ctx.params;
  return adminHandler(d, req, (s) => listInvoices(d, s, firmId));
}
