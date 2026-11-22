import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  auditSummaries,
  employees,
  enrolmentCodes,
  firmPolicies,
  firms,
  packGrants,
  servers,
  skillPacks,
} from "@/db/schema";
import { canonical, HEADERS } from "@/lib/agent-auth";
import {
  auditSummary,
  ENROLMENT_SERVER_ID,
  enroll,
  hashCode,
  heartbeat,
  policy,
  type Deps,
} from "@/lib/agent-api";
import type { DB } from "@/lib/db";
import { serverUuid, uuidv7 } from "@/lib/ids";
import { testDb } from "./helpers/db";

const NOW = new Date("2026-11-22T10:00:00Z");
const BASE = "https://console.offmanual.test";

let db: DB;
let close: () => Promise<void>;
let deps: Deps;
let firmId: string;
let otherFirmId: string;

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12); // strip SPKI prefix
  return { pub: raw.toString("base64"), priv: privateKey };
}

let nonceSeq = 0;
function signedRequest(
  priv: KeyObject,
  serverId: string,
  method: string,
  path: string,
  body?: unknown,
  over: { ts?: number; headers?: Record<string, string> } = {},
) {
  const raw = body === undefined ? new Uint8Array() : Buffer.from(JSON.stringify(body));
  const ts = over.ts ?? Math.floor(NOW.getTime() / 1000);
  const nonce = (++nonceSeq).toString(16).padStart(32, "0");
  const sig = cryptoSign(null, Buffer.from(canonical(method, path, serverId, ts, nonce, raw)), priv).toString(
    "base64",
  );
  return new Request(BASE + path, {
    method,
    body: method === "GET" ? null : raw,
    headers: {
      [HEADERS.server]: serverId,
      [HEADERS.timestamp]: String(ts),
      [HEADERS.nonce]: nonce,
      [HEADERS.signature]: sig,
      "content-type": "application/json",
      ...over.headers,
    },
  });
}

async function seedFirm(name: string) {
  const id = uuidv7();
  await db
    .insert(firms)
    .values({ id, name, legalName: name + " LLP", stateCode: "27", billingEmail: "a@b.in" });
  return id;
}

async function addCode(fid: string, code: string, expiresAt = new Date(NOW.getTime() + 86400e3)) {
  await db
    .insert(enrolmentCodes)
    .values({ id: uuidv7(), firmId: fid, serverName: "RDS01", codeHash: hashCode(code), expiresAt });
}

async function enrolServer(fid: string, code = "OMLAB-0001-ABCD") {
  await addCode(fid, code);
  const k = keypair();
  const res = await enroll(
    deps,
    signedRequest(k.priv, ENROLMENT_SERVER_ID, "POST", "/api/agent/enroll", {
      code,
      publicKey: k.pub,
      hostname: "OMLAB-RDS",
      agentVersion: "1.0.0",
    }),
  );
  expect(res.status).toBe(201);
  const { serverId } = (await res.json()) as { serverId: string };
  return { serverId, ...k };
}

beforeEach(async () => {
  ({ db, close } = await testDb());
  deps = { db, now: () => NOW };
  firmId = await seedFirm("Mehta & Co");
  otherFirmId = await seedFirm("Shah Associates");
});
afterEach(async () => close());

describe("POST /api/agent/enroll", () => {
  it("enrols with a valid code, once", async () => {
    const { serverId, pub } = await enrolServer(firmId);
    expect(serverId).toMatch(/^srv_[0-9a-f]{32}$/);
    const row = (
      await db
        .select()
        .from(servers)
        .where(eq(servers.id, serverUuid(serverId)!))
    )[0]!;
    expect(row.firmId).toBe(firmId);
    expect(row.publicKey).toBe(pub);
    // The code is single-use.
    const k = keypair();
    const again = await enroll(
      deps,
      signedRequest(k.priv, ENROLMENT_SERVER_ID, "POST", "/api/agent/enroll", {
        code: "OMLAB-0001-ABCD",
        publicKey: k.pub,
        hostname: "X",
        agentVersion: "1.0.0",
      }),
    );
    expect(again.status).toBe(403);
  });

  it("rejects expired codes, a key that didn't sign the request, unknown fields", async () => {
    await addCode(firmId, "EXPIRED-CODE-01", new Date(NOW.getTime() - 1000));
    const k = keypair();
    const body = { code: "EXPIRED-CODE-01", publicKey: k.pub, hostname: "H", agentVersion: "1.0.0" };
    expect(
      (await enroll(deps, signedRequest(k.priv, ENROLMENT_SERVER_ID, "POST", "/api/agent/enroll", body)))
        .status,
    ).toBe(403);

    await addCode(firmId, "GOOD-CODE-0001");
    const other = keypair();
    const stolen = { code: "GOOD-CODE-0001", publicKey: k.pub, hostname: "H", agentVersion: "1.0.0" };
    // Signed by a different key than the one being enrolled: no proof of possession.
    expect(
      (
        await enroll(
          deps,
          signedRequest(other.priv, ENROLMENT_SERVER_ID, "POST", "/api/agent/enroll", stolen),
        )
      ).status,
    ).toBe(401);

    const extra = { ...stolen, firmId: otherFirmId };
    expect(
      (await enroll(deps, signedRequest(k.priv, ENROLMENT_SERVER_ID, "POST", "/api/agent/enroll", extra)))
        .status,
    ).toBe(400);
  });
});

describe("signed agent routes", () => {
  it("heartbeat updates the server and returns firm status", async () => {
    const s = await enrolServer(firmId);
    const res = await heartbeat(
      deps,
      signedRequest(s.priv, s.serverId, "POST", "/api/agent/heartbeat", {
        agentVersion: "1.0.1",
        openclawVersion: "2026.11.6",
        health: "green",
        activeSeats: 7,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ firmStatus: "trial", offlineGraceDays: 7 });
    const row = (
      await db
        .select()
        .from(servers)
        .where(eq(servers.id, serverUuid(s.serverId)!))
    )[0]!;
    expect(row).toMatchObject({ agentVersion: "1.0.1", health: "green", activeSeats: 7 });
    expect(row.lastHeartbeatAt?.toISOString()).toBe(NOW.toISOString());
  });

  it("refuses client content and unknown fields", async () => {
    const s = await enrolServer(firmId);
    const res = await heartbeat(
      deps,
      signedRequest(s.priv, s.serverId, "POST", "/api/agent/heartbeat", {
        agentVersion: "1.0.1",
        health: "green",
        activeSeats: 1,
        lastPrompt: "reconcile Mehta Traders bank statement",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("refuses replays, wrong keys, skewed clocks and revoked servers", async () => {
    const s = await enrolServer(firmId);
    const body = { agentVersion: "1.0.1", health: "green", activeSeats: 1 };
    const req = signedRequest(s.priv, s.serverId, "POST", "/api/agent/heartbeat", body);
    const replay = req.clone();
    expect((await heartbeat(deps, req)).status).toBe(200);
    expect((await heartbeat(deps, replay)).status).toBe(401);

    const imposter = keypair();
    expect(
      (await heartbeat(deps, signedRequest(imposter.priv, s.serverId, "POST", "/api/agent/heartbeat", body)))
        .status,
    ).toBe(401);

    const old = signedRequest(s.priv, s.serverId, "POST", "/api/agent/heartbeat", body, {
      ts: NOW.getTime() / 1000 - 3600,
    });
    expect((await heartbeat(deps, old)).status).toBe(401);

    await db
      .update(servers)
      .set({ revokedAt: NOW })
      .where(eq(servers.id, serverUuid(s.serverId)!));
    expect(
      (await heartbeat(deps, signedRequest(s.priv, s.serverId, "POST", "/api/agent/heartbeat", body))).status,
    ).toBe(401);
  });

  it("policy returns only the calling firm's employees and packs, with an ETag", async () => {
    const s = await enrolServer(firmId);
    await db.insert(skillPacks).values([
      { key: "core", name: "Core" },
      { key: "tally-read", name: "Tally read" },
    ]);
    await db.insert(firmPolicies).values({ firmId, telegramMode: "text", version: 3 });
    const asha = uuidv7();
    await db.insert(employees).values([
      {
        id: asha,
        firmId,
        name: "Asha",
        email: "asha@mehta.in",
        windowsSid: "S-1-5-21-1-2-3-1101",
        status: "active",
      },
      { id: uuidv7(), firmId, name: "Not bound yet", email: "new@mehta.in", status: "invited" },
      {
        id: uuidv7(),
        firmId: otherFirmId,
        name: "Other firm",
        email: "x@shah.in",
        windowsSid: "S-1-5-21-9-9-9-1101",
        status: "active",
      },
    ]);
    await db.insert(packGrants).values([
      { id: uuidv7(), firmId, packKey: "core", employeeId: asha },
      { id: uuidv7(), firmId, packKey: "tally-read", adGroup: "OM-TallyRead" },
    ]);
    const res = await policy(deps, signedRequest(s.priv, s.serverId, "GET", "/api/agent/policy"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      policyVersion: number;
      employees: { sid: string; packs: string[] }[];
      adGroupGrants: unknown[];
    };
    expect(body.policyVersion).toBe(3);
    expect(body.employees).toEqual([
      { employeeId: asha, sid: "S-1-5-21-1-2-3-1101", name: "Asha", status: "active", packs: ["core"] },
    ]);
    expect(body.adGroupGrants).toEqual([{ adGroup: "OM-TallyRead", pack: "tally-read" }]);
    const etag = res.headers.get("etag")!;
    const cached = await policy(
      deps,
      signedRequest(s.priv, s.serverId, "GET", "/api/agent/policy", undefined, {
        headers: { "if-none-match": etag },
      }),
    );
    expect(cached.status).toBe(304);
  });

  it("audit summary stores counts per category and day (idempotent)", async () => {
    const s = await enrolServer(firmId);
    const send = (count: number) =>
      auditSummary(
        deps,
        signedRequest(s.priv, s.serverId, "POST", "/api/agent/audit-summary", {
          date: "2026-11-21",
          counts: [
            { category: "access_denied", count },
            { category: "review_approved", count: 2 },
          ],
        }),
      );
    expect((await send(3)).status).toBe(200);
    expect((await send(5)).status).toBe(200);
    const rows = await db.select().from(auditSummaries).where(eq(auditSummaries.firmId, firmId));
    expect(rows.map((r) => [r.category, r.count]).sort()).toEqual([
      ["access_denied", 5],
      ["review_approved", 2],
    ]);
    const withPath = await auditSummary(
      deps,
      signedRequest(s.priv, s.serverId, "POST", "/api/agent/audit-summary", {
        date: "2026-11-21",
        counts: [{ category: "access_denied", count: 1, target: "\\\\fs\\Clients\\Mehta" }],
      }),
    );
    expect(withPath.status).toBe(400);
  });
});

describe("ids", () => {
  it("uuidv7 is time-ordered and well-formed", async () => {
    const { uuidv7: gen } = await import("@/lib/ids");
    const a = gen(1_700_000_000_000);
    const b = gen(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(serverUuid("srv_nothex")).toBeNull();
  });
});
