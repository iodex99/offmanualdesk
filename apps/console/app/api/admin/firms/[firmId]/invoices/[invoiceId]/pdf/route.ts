import { InputError } from "@/lib/admin";
import { readCookie } from "@/lib/auth-routes";
import { AuthError, getSession, SESSION_COOKIE } from "@/lib/auth";
import { invoicePdf } from "@/lib/billing/admin";
import { billingConfigFromEnv } from "@/lib/billing/run";
import { routeDeps } from "@/lib/deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET: the invoice PDF (firm-scoped; drafts only for Off Manual staff). */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ firmId: string; invoiceId: string }> },
): Promise<Response> {
  const { firmId, invoiceId } = await ctx.params;
  const d = routeDeps();
  const s = await getSession(d, readCookie(req, SESSION_COOKIE));
  try {
    const { filename, bytes } = await invoicePdf(d, billingConfigFromEnv(), s, firmId, invoiceId);
    return new Response(Buffer.from(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    const status = e instanceof AuthError ? e.status : e instanceof InputError ? 404 : 500;
    if (status === 500) throw e;
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
}
