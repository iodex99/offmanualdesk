import { getDb } from "@/lib/db";
import { registerRelease } from "@/lib/releases";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return registerRelease(
    { db: getDb(), now: () => new Date(), registerToken: process.env.OM_RELEASE_REGISTER_TOKEN },
    req,
  );
}
