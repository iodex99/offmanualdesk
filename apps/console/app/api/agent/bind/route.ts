import { agentBind } from "@/lib/agent-api";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  return agentBind({ db: getDb(), now: () => new Date() }, req);
}
