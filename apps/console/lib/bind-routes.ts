// Employee sign-in for binding (ARCHITECTURE F2, ADR-044): OIDC with a verified email,
// then a one-time code page. No console session is created for employees.
import { BindError, createBindCode } from "./bind";
import { cookie, OIDC_COOKIE, redirect, startLogin, verifyCallback, type RouteDeps } from "./auth-routes";

export const BIND_PATHS = { callback: "/bind/callback", errorPage: "/bind" };

/** GET /bind/login/[provider] */
export function startBindLogin(deps: RouteDeps, provider: string): Promise<Response> {
  return startLogin(deps, provider, BIND_PATHS);
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A small self-contained page (no client data; the code is for this person only). */
export function codePage(title: string, body: string, status = 200, cookies: string[] = []): Response {
  const h = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
  for (const c of cookies) h.append("set-cookie", c);
  const html = `<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}.code{font-size:2.5rem;letter-spacing:.2rem;font-family:ui-monospace,monospace}</style></head><body>${body}</body></html>`;
  return new Response(html, { status, headers: h });
}

/** GET /bind/callback/[provider] */
export async function finishBindLogin(deps: RouteDeps, provider: string, req: Request): Promise<Response> {
  const clear = cookie(OIDC_COOKIE, "", 0, deps.secureCookies);
  const v = await verifyCallback(deps, provider, req);
  if (!v.ok) return redirect(`${deps.baseUrl}/bind?error=${v.error}`, [clear]);
  try {
    const { code, name } = await createBindCode(deps, v.identity);
    return codePage(
      "Your Off Manual code",
      `<h1>Hello ${escape(name)}</h1><p>Type this code into Off Manual Desk on <strong>your own</strong> Windows sign-in:</p><p class="code">${escape(code)}</p><p>It works once and expires in 10 minutes. Never give it to anyone else, even someone from your office.</p>`,
      200,
      [clear],
    );
  } catch (e) {
    if (e instanceof BindError) {
      return codePage("Off Manual", `<h1>Can't sign you in</h1><p>${escape(e.message)}</p>`, e.status, [
        clear,
      ]);
    }
    throw e;
  }
}
