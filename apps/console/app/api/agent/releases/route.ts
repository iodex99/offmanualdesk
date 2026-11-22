import { agentReleases } from "@/lib/agent-api";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request): Promise<Response> {
  return agentReleases({ db: getDb(), now: () => new Date() }, req);
}
