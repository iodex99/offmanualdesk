import { finishLogin } from "@/lib/auth-routes";
import { routeDeps } from "@/lib/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  return finishLogin(routeDeps(), (await ctx.params).provider, req);
}
