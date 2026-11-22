import { generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindCodes, employees, enrolmentCodes, firms, invites, packGrants, skillPacks } from "@/db/schema";
import { canonical, HEADERS } from "@/lib/agent-auth";
import { agentBind, ENROLMENT_SERVER_ID, enroll, hashCode } from "@/lib/agent-api";
import { OIDC_COOKIE, type RouteDeps } from "@/lib/auth-routes";
import {
  BindError,
  createBindCode,
  hashBindCode,
  newBindCode,
  normaliseBindCode,
  redeemBindCode,
} from "@/lib/bind";
import { finishBindLogin, startBindLogin } from "@/lib/bind-routes";
import type { DB } from "@/lib/db";
import { uuidv7 } from "@/lib/ids";
import type { IdentityProvider, VerifiedIdentity } from "@/lib/oidc";
import { testDb } from "./helpers/db";

const NOW = new Date("2026-11-23T05:00:00Z");
const BASE = "https://console.test";
const SID_ASHA = "S-1-5-21-111-222-333-1101";
const SID_RAVI = "S-1-5-21-111-222-333-1102";

let db: DB;
let close: () => Promise<void>;
let now = NOW;
const deps = () => ({ db, now: () => now });
let firmA: string;
let firmB: string;

async function seedFirm(name: string) {
  const id = uuidv7();
  await db.insert(firms).values({ id, name, legalName: name, stateCode: "27", billingEmail: "a@b.in" });
  return id;
}

async function addEmployee(firmId: string, email: string, over: Partial<typeof employees.$inferInsert> = {}) {
  const id = uuidv7();
  await db.insert(employees).values({ id, firmId, name: email.split("@")[0]!, email, ...over });
  return id;
}

const google = (email: string, subject = "sub-" + email): VerifiedIdentity => ({
  email,
  subject,
  provider: "google",
});

beforeEach(async () => {
  ({ db, close } = await testDb());
  now = NOW;
  firmA = await seedFirm("Mehta & Co");
  firmB = await seedFirm("Shah Associates");
});
afterEach(async () => close());

describe("bind codes", () => {
  it("format and normalisation", () => {
    const c = newBindCode();
    expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(normaliseBindCode(" abcd-efgh ")).toBe("ABCDEFGH");
    expect(hashBindCode("abcd-efgh")).toBe(hashBindCode("ABCDEFGH"));
  });

  it("creates one live code per employee; refuses unknown, disabled and duplicate emails", async () => {
    const asha = await addEmployee(firmA, "asha@mehta.in");
    const first = await createBindCode(deps(), google("Asha@Mehta.in"));
    const second = await createBindCode(deps(), google("asha@mehta.in"));
    expect(first.name).toBe("asha");
    const rows = await db.select().from(bindCodes).where(eq(bindCodes.employeeId, asha));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).toBe(hashBindCode(second.code));

    await expect(createBindCode(deps(), google("nobody@x.in"))).rejects.toMatchObject({ status: 404 });
    await addEmployee(firmA, "gone@mehta.in", { status: "disabled" });
    await expect(createBindCode(deps(), google("gone@mehta.in"))).rejects.toMatchObject({ status: 404 });
    await addEmployee(firmA, "dup@x.in");
    await addEmployee(firmB, "dup@x.in");
    await expect(createBindCode(deps(), google("dup@x.in"))).rejects.toMatchObject({ status: 409 });
  });

  it("an employee already bound must use the same sign-in account", async () => {
    await addEmployee(firmA, "asha@mehta.in", { oauthProvider: "google", oauthSubject: "sub-1" });
    await expect(createBindCode(deps(), google("asha@mehta.in", "sub-OTHER"))).rejects.toMatchObject({
      status: 409,
    });
    await expect(createBindCode(deps(), google("asha@mehta.in", "sub-1"))).resolves.toBeTruthy();
  });
});

describe("redeemBindCode", () => {
  it("binds the SID, activates, accepts the invite and returns packs; single use", async () => {
    const asha = await addEmployee(firmA, "asha@mehta.in");
    await db.insert(invites).values({ id: uuidv7(), employeeId: asha, channel: "email" });
    await db.insert(skillPacks).values({ key: "core", name: "Core" });
    await db.insert(packGrants).values({ id: uuidv7(), firmId: firmA, packKey: "core", employeeId: asha });
    const { code } = await createBindCode(deps(), google("asha@mehta.in", "g-77"));
    const r = await redeemBindCode(deps(), firmA, code.toLowerCase(), SID_ASHA);
    expect(r).toEqual({ employeeId: asha, name: "asha", status: "active", packs: ["core"] });
    const e = (await db.select().from(employees).where(eq(employees.id, asha)))[0]!;
    expect(e).toMatchObject({
      windowsSid: SID_ASHA,
      status: "active",
      oauthProvider: "google",
      oauthSubject: "g-77",
    });
    expect((await db.select().from(invites).where(eq(invites.employeeId, asha)))[0]!.acceptedAt).toEqual(NOW);
    await expect(redeemBindCode(deps(), firmA, code, SID_ASHA)).rejects.toMatchObject({ status: 404 });
  });

  it("same answer for expired, other-firm and unknown codes", async () => {
    await addEmployee(firmA, "asha@mehta.in");
    const { code } = await createBindCode(deps(), google("asha@mehta.in"));
    const msgs = new Set<string>();
    for (const attempt of [
      () => redeemBindCode(deps(), firmB, code, SID_ASHA), // a server of another firm
      () => redeemBindCode(deps(), firmA, "ZZZZ-ZZZZ", SID_ASHA),
      () => redeemBindCode(deps(), firmA, "not a code!", SID_ASHA),
    ]) {
      const e = await attempt().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(BindError);
      expect((e as BindError).status).toBe(404);
      msgs.add((e as BindError).message);
    }
    now = new Date(NOW.getTime() + 11 * 60 * 1000);
    const e = await redeemBindCode(deps(), firmA, code, SID_ASHA).catch((x: unknown) => x);
    msgs.add((e as BindError).message);
    expect(msgs.size).toBe(1);
  });

  it("refuses a different Windows account, a SID bound to someone else and a malformed SID", async () => {
    await addEmployee(firmA, "asha@mehta.in", { windowsSid: SID_ASHA });
    await addEmployee(firmA, "ravi@mehta.in", { windowsSid: SID_RAVI });
    const a = await createBindCode(deps(), google("asha@mehta.in"));
    await expect(redeemBindCode(deps(), firmA, a.code, SID_RAVI)).rejects.toMatchObject({ status: 409 });
    await addEmployee(firmA, "new@mehta.in");
    const n = await createBindCode(deps(), google("new@mehta.in"));
    await expect(redeemBindCode(deps(), firmA, n.code, SID_RAVI)).rejects.toMatchObject({ status: 409 });
    await expect(redeemBindCode(deps(), firmA, n.code, "S-1-5-18")).rejects.toMatchObject({ status: 400 });
    // Re-binding the same SID (e.g. a reinstall) is fine.
    await expect(redeemBindCode(deps(), firmA, a.code, SID_ASHA)).resolves.toMatchObject({
      status: "active",
    });
  });
});

// ---- signed agent endpoint ----

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { pub: raw.toString("base64"), priv: privateKey };
}
let nonceSeq = 0;
function signed(priv: KeyObject, serverId: string, path: string, body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  const ts = Math.floor(now.getTime() / 1000);
  const nonce = (++nonceSeq).toString(16).padStart(32, "0");
  const sig = cryptoSign(null, Buffer.from(canonical("POST", path, serverId, ts, nonce, raw)), priv).toString(
    "base64",
  );
  return new Request(BASE + path, {
    method: "POST",
    body: raw,
    headers: {
      [HEADERS.server]: serverId,
      [HEADERS.timestamp]: String(ts),
      [HEADERS.nonce]: nonce,
      [HEADERS.signature]: sig,
      "content-type": "application/json",
    },
  });
}
async function enrolServer(firmId: string, code: string) {
  await db.insert(enrolmentCodes).values({
    id: uuidv7(),
    firmId,
    serverName: "RDS01",
    codeHash: hashCode(code),
    expiresAt: new Date(NOW.getTime() + 86400e3),
  });
  const k = keypair();
  const res = await enroll(
    deps(),
    signed(k.priv, ENROLMENT_SERVER_ID, "/api/agent/enroll", {
      code,
      publicKey: k.pub,
      hostname: "RDS01",
      agentVersion: "1.0.0",
    }),
  );
  const { serverId } = (await res.json()) as { serverId: string };
  return { serverId, priv: k.priv };
}

describe("POST /api/agent/bind", () => {
  it("binds through a signed request; refuses unsigned, unknown fields and other firms", async () => {
    const asha = await addEmployee(firmA, "asha@mehta.in");
    const srvA = await enrolServer(firmA, "OMA-0001");
    const srvB = await enrolServer(firmB, "OMB-0001");
    const { code } = await createBindCode(deps(), google("asha@mehta.in"));

    const unsigned = await agentBind(
      deps(),
      new Request(BASE + "/api/agent/bind", {
        method: "POST",
        body: JSON.stringify({ code, sid: SID_ASHA }),
      }),
    );
    expect([400, 401]).toContain(unsigned.status); // rejected before the body is read
    const extra = await agentBind(
      deps(),
      signed(srvA.priv, srvA.serverId, "/api/agent/bind", { code, sid: SID_ASHA, name: "x" }),
    );
    expect(extra.status).toBe(400);
    const other = await agentBind(
      deps(),
      signed(srvB.priv, srvB.serverId, "/api/agent/bind", { code, sid: SID_ASHA }),
    );
    expect(other.status).toBe(404);
    const ok = await agentBind(
      deps(),
      signed(srvA.priv, srvA.serverId, "/api/agent/bind", { code, sid: SID_ASHA }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ employeeId: asha, name: "asha", status: "active", packs: [] });
  });
});

// ---- employee sign-in pages ----

describe("bind sign-in routes", () => {
  let email = "asha@mehta.in";
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
    async finish(_u, expected) {
      if (expected.state !== "st") throw new Error("state");
      return { email, subject: "sub-1", provider: "google" };
    },
  };
  const routeDeps = (): RouteDeps => ({
    db,
    now: () => now,
    dataKey: randomBytes(32),
    providers: { google: fake },
    baseUrl: BASE,
    secureCookies: true,
  });

  async function callback() {
    const start = await startBindLogin(routeDeps(), "google");
    expect(start.headers.get("location")).toContain(encodeURIComponent(`${BASE}/bind/callback/google`));
    const oidc = start.headers
      .getSetCookie()
      .find((c) => c.startsWith(OIDC_COOKIE))!
      .split(";")[0]!;
    return finishBindLogin(
      routeDeps(),
      "google",
      new Request(`${BASE}/bind/callback/google?code=x&state=st`, { headers: { cookie: oidc } }),
    );
  }

  it("shows a one-time code for an invited employee, escaped, never cached", async () => {
    await addEmployee(firmA, "asha@mehta.in", { name: "Asha <b>K</b>" });
    email = "asha@mehta.in";
    const res = await callback();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("Asha &lt;b&gt;K&lt;/b&gt;");
    const code = /class="code">([A-Z2-9]{4}-[A-Z2-9]{4})</.exec(html)?.[1];
    expect(code).toBeTruthy();
    await expect(redeemBindCode(deps(), firmA, code!, SID_ASHA)).resolves.toMatchObject({ status: "active" });
  });

  it("plain page for an email that isn't invited; expired cookie goes back to /bind", async () => {
    email = "stranger@x.in";
    const res = await callback();
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("set up for Off Manual. Ask your firm");
    const noCookie = await finishBindLogin(
      routeDeps(),
      "google",
      new Request(`${BASE}/bind/callback/google?code=x`),
    );
    expect(noCookie.headers.get("location")).toBe(`${BASE}/bind?error=expired`);
  });
});
