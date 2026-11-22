import { agentSupport } from "@/lib/agent-api";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(req: Request): Promise<Response> {
  return agentSupport({ db: getDb(), now: () => new Date() }, req);
}
