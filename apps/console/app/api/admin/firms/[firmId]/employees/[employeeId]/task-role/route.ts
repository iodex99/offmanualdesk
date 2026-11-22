import { setTaskRole } from "@/lib/admin";
import { adminHandler } from "@/lib/admin-routes";
import { routeDeps } from "@/lib/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST { taskRole }: which task buttons Desk shows first (ADR-061). */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ firmId: string; employeeId: string }> },
): Promise<Response> {
  const { firmId, employeeId } = await ctx.params;
  const d = routeDeps();
  return adminHandler(d, req, (s, body) => setTaskRole(d, s, firmId, employeeId, body));
}
