import { adminHandler } from "@/lib/admin-routes";
import { routeDeps } from "@/lib/deps";
import { updatePolicy } from "@/lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(req: Request, ctx: { params: Promise<{ firmId: string }> }): Promise<Response> {
  const { firmId } = await ctx.params;
  const d = routeDeps();
  return adminHandler(d, req, (s, body) => updatePolicy(d, s, firmId, body));
}
