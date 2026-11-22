import { startLogin } from "@/lib/auth-routes";
import { routeDeps } from "@/lib/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  return startLogin(routeDeps(), (await ctx.params).provider);
}
