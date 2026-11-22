import { finishBindLogin } from "@/lib/bind-routes";
import { routeDeps } from "@/lib/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  return finishBindLogin(routeDeps(), (await ctx.params).provider, req);
}
