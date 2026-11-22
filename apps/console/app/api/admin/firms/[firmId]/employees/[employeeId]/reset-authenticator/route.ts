import { resetAuthenticator } from "@/lib/admin";
import { adminHandler } from "@/lib/admin-routes";
import { routeDeps } from "@/lib/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST: reset the employee's authenticator at the next server sync (ADR-049). */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ firmId: string; employeeId: string }> },
): Promise<Response> {
  const { firmId, employeeId } = await ctx.params;
  const d = routeDeps();
  return adminHandler(d, req, (s) => resetAuthenticator(d, s, firmId, employeeId));
}
