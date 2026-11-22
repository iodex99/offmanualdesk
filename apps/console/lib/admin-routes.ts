// Wraps admin operations as JSON API handlers: session from cookie, plain errors,
// CSRF guard (mutations must be application/json, which a cross-site form can't send
// without a CORS preflight; cookies are SameSite=Lax).
import { AuthError, getSession, SESSION_COOKIE, type AuthDeps, type SessionState } from "./auth";
import { readCookie } from "./auth-routes";
import { InputError } from "./admin";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export async function adminHandler(
  deps: AuthDeps,
  req: Request,
  op: (s: SessionState | null, body: unknown) => Promise<unknown>,
): Promise<Response> {
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  if (mutating && !(req.headers.get("content-type") ?? "").startsWith("application/json")) {
    return json(415, { error: "Send JSON." });
  }
  let body: unknown = undefined;
  if (mutating) {
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Some details are missing or not in the right format." });
    }
  }
  const s = await getSession(deps, readCookie(req, SESSION_COOKIE));
  try {
    return json(200, await op(s, body));
  } catch (e) {
    if (e instanceof AuthError) return json(e.status, { error: e.message });
    if (e instanceof InputError) return json(400, { error: e.message });
    throw e;
  }
}
