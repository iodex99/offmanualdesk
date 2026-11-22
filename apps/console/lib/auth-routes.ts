// HTTP handlers for console sign-in (ADR-037). Route files only wire production deps.
import { z } from "zod";
import {
  AuthError,
  createSession,
  destroySession,
  getSession,
  principalByEmail,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  totpEnrolled,
  totpEnrolStart,
  totpVerify,
  type AuthDeps,
} from "./auth";
import type { IdentityProvider, ProviderName, VerifiedIdentity } from "./oidc";

export const OIDC_COOKIE = "om_oidc";

export interface RouteDeps extends AuthDeps {
  providers: Partial<Record<ProviderName, IdentityProvider>>;
  baseUrl: string; // e.g. https://console.offmanual.in
  secureCookies: boolean;
}

export function cookie(name: string, value: string, maxAgeSec: number, secure: boolean): string {
  return [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export const redirect = (to: string, cookies: string[] = []) => {
  const h = new Headers({ location: to, "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 303, headers: h });
};

const json = (status: number, body: unknown, cookies: string[] = []) => {
  const h = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status, headers: h });
};

/** GET /auth/login/[provider] (also /bind/login/[provider] with its own callback and error page). */
export async function startLogin(
  deps: RouteDeps,
  provider: string,
  paths: { callback: string; errorPage: string } = { callback: "/auth/callback", errorPage: "/sign-in" },
): Promise<Response> {
  const p = deps.providers[provider as ProviderName];
  if (!p) return redirect(`${deps.baseUrl}${paths.errorPage}?error=provider`);
  const s = await p.start(`${deps.baseUrl}${paths.callback}/${p.name}`);
  const payload = Buffer.from(JSON.stringify({ p: p.name, s: s.state, n: s.nonce, v: s.verifier })).toString(
    "base64url",
  );
  return redirect(s.url, [cookie(OIDC_COOKIE, payload, 600, deps.secureCookies)]);
}

const oidcCookie = z
  .object({ p: z.enum(["google", "microsoft"]), s: z.string(), n: z.string(), v: z.string() })
  .strict();

function parseOidcCookie(raw: string | undefined): z.infer<typeof oidcCookie> | null {
  if (!raw) return null;
  try {
    return oidcCookie.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    return null; // tampered or old cookie: the caller sends the user back to sign in
  }
}

/**
 * Completes the OIDC callback: state/nonce/PKCE from the short-lived cookie, verified
 * email from the provider. Returns the identity or an error code for the page.
 */
export async function verifyCallback(
  deps: RouteDeps,
  provider: string,
  req: Request,
): Promise<{ ok: true; identity: VerifiedIdentity } | { ok: false; error: "expired" | "provider" }> {
  const saved = parseOidcCookie(readCookie(req, OIDC_COOKIE));
  const p = deps.providers[provider as ProviderName];
  if (!saved || !p || saved.p !== p.name) return { ok: false, error: "expired" };
  try {
    return {
      ok: true,
      identity: await p.finish(new URL(req.url), { state: saved.s, nonce: saved.n, verifier: saved.v }),
    };
  } catch {
    return { ok: false, error: "provider" };
  }
}

/** GET /auth/callback/[provider] */
export async function finishLogin(deps: RouteDeps, provider: string, req: Request): Promise<Response> {
  const clear = cookie(OIDC_COOKIE, "", 0, deps.secureCookies);
  const v = await verifyCallback(deps, provider, req);
  if (!v.ok) return redirect(`${deps.baseUrl}/sign-in?error=${v.error}`, [clear]);
  const identity = v.identity;
  const principal = await principalByEmail(deps.db, identity.email);
  if (!principal) return redirect(`${deps.baseUrl}/sign-in?error=not-registered`, [clear]);
  const token = await createSession(deps, principal);
  return redirect(`${deps.baseUrl}/sign-in/totp`, [
    clear,
    cookie(SESSION_COOKIE, token, Math.floor(SESSION_TTL_MS / 1000), deps.secureCookies),
  ]);
}

const totpBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("enrol-start") }).strict(),
  z.object({ action: z.literal("verify"), code: z.string().max(10) }).strict(),
]);

/** POST /api/auth/totp */
export async function totpRoute(deps: RouteDeps, req: Request): Promise<Response> {
  const s = await getSession(deps, readCookie(req, SESSION_COOKIE));
  if (!s) return json(401, { error: "Please sign in again." });
  let body;
  try {
    body = totpBody.parse(await req.json());
  } catch {
    return json(400, { error: "invalid request" });
  }
  try {
    switch (body.action) {
      case "status":
        return json(200, {
          enrolled: await totpEnrolled(deps, s.principal),
          mfa: s.mfa,
          name: s.principal.name,
        });
      case "enrol-start":
        return json(200, await totpEnrolStart(deps, s));
      case "verify":
        await totpVerify(deps, s, body.code);
        return json(200, {
          ok: true,
          next: s.principal.kind === "console" ? "/fleet" : `/firms/${s.principal.firmId}`,
        });
    }
  } catch (e) {
    if (e instanceof AuthError) return json(e.status, { error: e.message });
    throw e;
  }
}

/** POST /auth/logout */
export async function logout(deps: RouteDeps, req: Request): Promise<Response> {
  const t = readCookie(req, SESSION_COOKIE);
  if (t) await destroySession(deps, t);
  return redirect(`${deps.baseUrl}/sign-in`, [cookie(SESSION_COOKIE, "", 0, deps.secureCookies)]);
}
