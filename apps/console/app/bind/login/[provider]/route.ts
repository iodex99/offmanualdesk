import { startBindLogin } from "@/lib/bind-routes";
import { routeDeps } from "@/lib/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  return startBindLogin(routeDeps(), (await ctx.params).provider);
}
