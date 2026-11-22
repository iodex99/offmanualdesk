import { adminHandler } from "@/lib/admin-routes";
import { routeDeps } from "@/lib/deps";
import { postNotice } from "@/lib/notices";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST: a notice for one firm's Desks (staff or that firm's admin) or all firms (staff). */
export function POST(req: Request): Promise<Response> {
  const d = routeDeps();
  return adminHandler(d, req, (s, body) => postNotice(d, s, body));
}
