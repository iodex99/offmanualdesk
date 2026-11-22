import { adminHandler } from "@/lib/admin-routes";
import { routeDeps } from "@/lib/deps";
import { addEmployee, listEmployees } from "@/lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ firmId: string }> }): Promise<Response> {
  const { firmId } = await ctx.params;
  const d = routeDeps();
  return adminHandler(d, req, (s) => listEmployees(d, s, firmId));
}

export async function POST(req: Request, ctx: { params: Promise<{ firmId: string }> }): Promise<Response> {
  const { firmId } = await ctx.params;
  const d = routeDeps();
  return adminHandler(d, req, (s, body) => addEmployee(d, s, firmId, body));
}
