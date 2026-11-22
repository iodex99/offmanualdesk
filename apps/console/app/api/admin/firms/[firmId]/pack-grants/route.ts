import { adminHandler } from "@/lib/admin-routes";
import { routeDeps } from "@/lib/deps";
import { grantPack } from "@/lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ firmId: string }> }): Promise<Response> {
  const { firmId } = await ctx.params;
  const d = routeDeps();
  return adminHandler(d, req, (s, body) => grantPack(d, s, firmId, body));
}
