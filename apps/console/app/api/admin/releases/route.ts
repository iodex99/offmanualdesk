import { adminHandler } from "@/lib/admin-routes";
import { routeDeps } from "@/lib/deps";
import { releaseAction } from "@/lib/releases";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  const d = routeDeps();
  return adminHandler(d, req, (s, body) =>
    releaseAction({ db: d.db, now: d.now, allowUnsigned: allowUnsignedFromEnv() }, s, body),
  );
}

function allowUnsignedFromEnv(): boolean {
  return process.env.OM_ALLOW_UNSIGNED_RELEASES === "true";
}
