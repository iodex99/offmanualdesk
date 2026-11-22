import { totpRoute } from "@/lib/auth-routes";
import { routeDeps } from "@/lib/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return totpRoute(routeDeps(), req);
}
