import { adminHandler } from "@/lib/admin-routes";
import { routeDeps } from "@/lib/deps";
import { importEmployees } from "@/lib/setup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST { text }: one "Name, email" per line (ADR-054). */
export async function POST(req: Request, ctx: { params: Promise<{ firmId: string }> }): Promise<Response> {
  const { firmId } = await ctx.params;
  const d = routeDeps();
  return adminHandler(d, req, (s, body) => importEmployees(d, s, firmId, body));
}
