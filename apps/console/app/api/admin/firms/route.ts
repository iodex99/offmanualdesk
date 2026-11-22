import { adminHandler } from "@/lib/admin-routes";
import { routeDeps } from "@/lib/deps";
import { createFirm, listFirms } from "@/lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request): Promise<Response> {
  const d = routeDeps();
  return adminHandler(d, req, (s) => listFirms(d, s));
}

export function POST(req: Request): Promise<Response> {
  const d = routeDeps();
  return adminHandler(d, req, (s, body) => createFirm(d, s, body));
}
