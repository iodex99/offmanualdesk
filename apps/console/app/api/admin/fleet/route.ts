import { adminHandler } from "@/lib/admin-routes";
import { routeDeps } from "@/lib/deps";
import { fleet } from "@/lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request): Promise<Response> {
  const d = routeDeps();
  return adminHandler(d, req, (s) => fleet(d, s));
}
