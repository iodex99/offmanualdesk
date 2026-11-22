import { agentNotices } from "@/lib/agent-api";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request): Promise<Response> {
  return agentNotices({ db: getDb(), now: () => new Date() }, req);
}
