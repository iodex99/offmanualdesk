import { adminHandler } from "@/lib/admin-routes";
import { routeDeps } from "@/lib/deps";
import { setEmployeeStatus } from "@/lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ firmId: string; employeeId: string }> },
): Promise<Response> {
  const { firmId, employeeId } = await ctx.params;
  const d = routeDeps();
  return adminHandler(d, req, (s, body) =>
    setEmployeeStatus(d, s, firmId, employeeId, (body as { status?: unknown })?.status),
  );
}
