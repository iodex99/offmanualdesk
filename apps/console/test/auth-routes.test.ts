import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consoleUsers } from "@/db/schema";
import { SESSION_COOKIE } from "@/lib/auth";
import { finishLogin, logout, OIDC_COOKIE, startLogin, totpRoute, type RouteDeps } from "@/lib/auth-routes";
import type { DB } from "@/lib/db";
import { uuidv7 } from "@/lib/ids";
import type { IdentityProvider } from "@/lib/oidc";
import { base32Decode, hotp } from "@/lib/totp";
import { testDb } from "./helpers/db";

let db: DB;
let close: () => Promise<void>;
let deps: RouteDeps;
let identityEmail = "dwahnil@offmanual.in";
const NOW = new Date("2026-11-22T10:00:00Z");
const BASE = "https://console.test";

const fake: IdentityProvider = {
  name: "google",
  async start(redirectUri) {
    return {
      url: `https://accounts.example/auth?redirect_uri=${encodeURIComponent(redirectUri)}`,
      state: "st",
      nonce: "no",
      verifier: "ve",
    };
  },
  async finish(_url, expected) {
    if (expected.state !== "st" || expected.verifier !== "ve") throw new Error("state mismatch");
    return { email: identityEmail, subject: "sub-1", provider: "google" };
  },
};

function setCookies(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(";");
    const [k, ...v] = kv!.split("=");
    out[k!] = v.join("=");
  }
  return out;
}

beforeEach(async () => {
  ({ db, close } = await testDb());
  deps = {
    db,
    now: () => NOW,
    dataKey: randomBytes(32),
    providers: { google: fake },
    baseUrl: BASE,
    secureCookies: true,
  };
  identityEmail = "dwahnil@offmanual.in";
  await db
    .insert(consoleUsers)
    .values({ id: uuidv7(), email: "dwahnil@offmanual.in", name: "Dwahnil", role: "superadmin" });
});
afterEach(async () => close());

async function signIn(): Promise<string> {
  const start = await startLogin(deps, "google");
  const oidc = setCookies(start)[OIDC_COOKIE]!;
  const cb = await finishLogin(
    deps,
    "google",
    new Request(`${BASE}/auth/callback/google?code=x&state=st`, {
      headers: { cookie: `${OIDC_COOKIE}=${oidc}` },
    }),
  );
  expect(cb.headers.get("location")).toBe(`${BASE}/sign-in/totp`);
  return setCookies(cb)[SESSION_COOKIE]!;
}

const totpReq = (token: string, body: unknown) =>
  new Request(`${BASE}/api/auth/totp`, {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("sign-in flow", () => {
  it("redirects to the provider with a short-lived HttpOnly Secure state cookie", async () => {
    const res = await startLogin(deps, "google");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain(encodeURIComponent(`${BASE}/auth/callback/google`));
    const raw = res.headers.getSetCookie()[0]!;
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/Secure/);
    expect(raw).toMatch(/Max-Age=600/);
    expect((await startLogin(deps, "github")).headers.get("location")).toBe(`${BASE}/sign-in?error=provider`);
  });

  it("callback → pre-MFA session → enrol TOTP → full access", async () => {
    const token = await signIn();
    let r = await totpRoute(deps, totpReq(token, { action: "status" }));
    expect(await r.json()).toEqual({ enrolled: false, mfa: false, name: "Dwahnil" });
    r = await totpRoute(deps, totpReq(token, { action: "enrol-start" }));
    const { secret } = (await r.json()) as { secret: string };
    const code = hotp(base32Decode(secret), Math.floor(NOW.getTime() / 30000));
    r = await totpRoute(deps, totpReq(token, { action: "verify", code }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, next: "/fleet" });
    r = await totpRoute(deps, totpReq(token, { action: "status" }));
    expect(await r.json()).toMatchObject({ enrolled: true, mfa: true });
  });

  it("unknown emails, missing/tampered state cookies and provider errors go back to sign-in", async () => {
    identityEmail = "stranger@gmail.com";
    const start = await startLogin(deps, "google");
    const oidc = setCookies(start)[OIDC_COOKIE]!;
    const cb = (cookie: string) =>
      finishLogin(
        deps,
        "google",
        new Request(`${BASE}/auth/callback/google?code=x`, { headers: { cookie } }),
      );
    expect((await cb(`${OIDC_COOKIE}=${oidc}`)).headers.get("location")).toBe(
      `${BASE}/sign-in?error=not-registered`,
    );
    expect((await cb("")).headers.get("location")).toBe(`${BASE}/sign-in?error=expired`);
    expect((await cb(`${OIDC_COOKIE}=not-base64-json`)).headers.get("location")).toBe(
      `${BASE}/sign-in?error=expired`,
    );
    const bad = Buffer.from(JSON.stringify({ p: "google", s: "WRONG", n: "no", v: "ve" })).toString(
      "base64url",
    );
    expect((await cb(`${OIDC_COOKIE}=${bad}`)).headers.get("location")).toBe(
      `${BASE}/sign-in?error=provider`,
    );
  });

  it("TOTP API needs a session and strict bodies; logout clears the cookie", async () => {
    expect((await totpRoute(deps, totpReq("nope", { action: "status" }))).status).toBe(401);
    const token = await signIn();
    expect((await totpRoute(deps, totpReq(token, { action: "verify", code: "1", extra: true }))).status).toBe(
      400,
    );
    const out = await logout(
      deps,
      new Request(`${BASE}/auth/logout`, {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
    );
    expect(out.headers.get("location")).toBe(`${BASE}/sign-in`);
    expect((await totpRoute(deps, totpReq(token, { action: "status" }))).status).toBe(401);
  });
});
