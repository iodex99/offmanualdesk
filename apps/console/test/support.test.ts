import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { employees, enrolmentCodes, firms, supportTickets } from "@/db/schema";
import { canonical, HEADERS } from "@/lib/agent-auth";
import { agentSupport, ENROLMENT_SERVER_ID, enroll, hashCode } from "@/lib/agent-api";
import type { SessionState } from "@/lib/auth";
import type { DB } from "@/lib/db";
import { uuidv7 } from "@/lib/ids";
import { listTickets, MAX_REPORTS_PER_SERVER_PER_DAY } from "@/lib/support";
import { testDb } from "./helpers/db";

const NOW = new Date("2026-11-23T05:00:00Z");
const BASE = "https://console.test";
let db: DB;
let close: () => Promise<void>;
const deps = () => ({ db, now: () => NOW });

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64"),
    priv: privateKey,
  };
}
let seq = 0;
function signed(priv: KeyObject, serverId: string, path: string, body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  const ts = Math.floor(NOW.getTime() / 1000);
  const nonce = (++seq).toString(16).padStart(32, "0");
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
async function firmWithServer(name: string, code: string) {
  const firmId = uuidv7();
  await db
    .insert(firms)
    .values({ id: firmId, name, legalName: name, stateCode: "27", billingEmail: "a@b.in" });
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
  return { firmId, serverId, priv: k.priv };
}

const bundle = {
  server: {
    agentVersion: "1.2.0",
    licence: "ok",
    preflight: {
      at: "2026-11-23T05:00:00Z",
      overall: "warn",
      results: [{ id: "ram", title: "Memory", status: "skip", detail: "16 GB" }],
    },
    logTail: ['{"level":"INFO","msg":"listening"}'],
  },
  desk: { deskVersion: "1.2.0", gatewayRunning: true },
};

beforeEach(async () => {
  ({ db, close } = await testDb());
});
afterEach(async () => close());

describe("POST /api/agent/support", () => {
  it("stores a report with a short reference; staff can list it", async () => {
    const a = await firmWithServer("Mehta", "OMA-0001");
    const emp = uuidv7();
    await db
      .insert(employees)
      .values({ id: emp, firmId: a.firmId, name: "Asha", email: "asha@mehta.in", status: "active" });
    const res = await agentSupport(
      deps(),
      signed(a.priv, a.serverId, "/api/agent/support", {
        employeeId: emp,
        description: "Desk is slow",
        bundle,
      }),
    );
    expect(res.status).toBe(201);
    const { ticket } = (await res.json()) as { ticket: string };
    expect(ticket).toMatch(/^OM-[A-HJ-NP-Z2-9]{6}$/);
    const staff: SessionState = {
      principal: { kind: "console", userId: "u", email: "d@om.in", name: "D", role: "staff" },
      mfa: true,
      token: "t",
    };
    const rows = await listTickets(deps(), staff);
    expect(rows[0]).toMatchObject({
      ref: ticket,
      firm: "Mehta",
      employee: "Asha",
      description: "Desk is slow",
      status: "open",
    });
    const firmAdmin: SessionState = {
      principal: {
        kind: "firm_admin",
        userId: "f",
        email: "o@m.in",
        name: "O",
        role: "owner",
        firmId: a.firmId,
      },
      mfa: true,
      token: "t",
    };
    await expect(listTickets(deps(), firmAdmin)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses unknown fields, oversized parts and another firm's employee", async () => {
    const a = await firmWithServer("Mehta", "OMA-0001");
    const b = await firmWithServer("Shah", "OMB-0001");
    const send = (body: unknown) =>
      agentSupport(deps(), signed(a.priv, a.serverId, "/api/agent/support", body));
    for (const bad of [
      { employeeId: "", description: "x", bundle, extra: 1 },
      { employeeId: "", description: "x".repeat(501), bundle },
      {
        employeeId: "",
        description: "x",
        bundle: { ...bundle, server: { ...bundle.server, files: ["C:\\Clients\\a.pdf"] } },
      },
      {
        employeeId: "",
        description: "x",
        bundle: { ...bundle, server: { ...bundle.server, logTail: Array(201).fill("x") } },
      },
      { employeeId: "", description: "x", bundle: { ...bundle, desk: { nested: { a: 1 } } } },
    ]) {
      expect((await send(bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    const other = uuidv7();
    await db
      .insert(employees)
      .values({ id: other, firmId: b.firmId, name: "X", email: "x@shah.in", status: "active" });
    expect((await send({ employeeId: other, description: "x", bundle })).status).toBe(201);
    const row = (await db.select().from(supportTickets))[0]!;
    expect(row.employeeId).toBeNull(); // not linked across firms
  });

  it("limits reports per server per day", async () => {
    const a = await firmWithServer("Mehta", "OMA-0001");
    for (let i = 0; i < MAX_REPORTS_PER_SERVER_PER_DAY; i++) {
      const r = await agentSupport(
        deps(),
        signed(a.priv, a.serverId, "/api/agent/support", { employeeId: "", description: `r${i}`, bundle }),
      );
      expect(r.status).toBe(201);
    }
    const r = await agentSupport(
      deps(),
      signed(a.priv, a.serverId, "/api/agent/support", { employeeId: "", description: "one more", bundle }),
    );
    expect(r.status).toBe(429);
    expect(((await r.json()) as { error: string }).error).toMatch(/Too many reports/);
  });
});
