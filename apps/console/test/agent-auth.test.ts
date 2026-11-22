import { readFileSync } from "node:fs";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HEADERS, MemoryNonceStore, canonical, verifyAgentRequest, verifySignature } from "../lib/agent-auth";

interface Vector {
  seedBase64: string;
  publicKeyBase64: string;
  method: string;
  pathAndQuery: string;
  serverId: string;
  timestamp: number;
  nonce: string;
  body: string;
  canonical: string;
  signatureBase64: string;
}

const v = JSON.parse(
  readFileSync(
    new URL("../../../packages/shared-schema/fixtures/agent-signature.json", import.meta.url),
    "utf8",
  ),
) as Vector;

// PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410).
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const privateKey = createPrivateKey({
  key: Buffer.concat([PKCS8_PREFIX, Buffer.from(v.seedBase64, "base64")]),
  format: "der",
  type: "pkcs8",
});

function signed(
  over: Partial<{ method: string; path: string; ts: number; nonce: string; body: string }> = {},
) {
  const method = over.method ?? "POST";
  const path = over.path ?? "/api/agent/heartbeat";
  const ts = over.ts ?? v.timestamp;
  const nonce = over.nonce ?? "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const body = over.body ?? v.body;
  const sig = cryptoSign(
    null,
    Buffer.from(canonical(method, path, v.serverId, ts, nonce, Buffer.from(body))),
    privateKey,
  ).toString("base64");
  const headers = new Headers({
    [HEADERS.server]: v.serverId,
    [HEADERS.timestamp]: String(ts),
    [HEADERS.nonce]: nonce,
    [HEADERS.signature]: sig,
  });
  return { method, path, headers, body: Buffer.from(body) };
}

const lookup = async (id: string) => (id === v.serverId ? v.publicKeyBase64 : null);
const at = (sec: number) => new Date(sec * 1000);

describe("golden vector shared with the Go agent", () => {
  it("canonical string matches", () => {
    expect(canonical(v.method, v.pathAndQuery, v.serverId, v.timestamp, v.nonce, Buffer.from(v.body))).toBe(
      v.canonical,
    );
  });
  it("Go's signature verifies here, and ours equals Go's (ed25519 is deterministic)", () => {
    expect(verifySignature(v.publicKeyBase64, v.canonical, v.signatureBase64)).toBe(true);
    expect(cryptoSign(null, Buffer.from(v.canonical), privateKey).toString("base64")).toBe(v.signatureBase64);
  });
});

describe("verifyAgentRequest", () => {
  it("accepts a fresh, correctly signed request once", async () => {
    const r = signed();
    const nonces = new MemoryNonceStore();
    const args = {
      method: r.method,
      pathAndQuery: r.path,
      headers: r.headers,
      body: r.body,
      lookupKey: lookup,
      nonces,
    };
    expect(await verifyAgentRequest({ ...args, now: at(v.timestamp + 10) })).toEqual({
      ok: true,
      serverId: v.serverId,
    });
    expect(await verifyAgentRequest({ ...args, now: at(v.timestamp + 20) })).toMatchObject({
      ok: false,
      reason: "replayed request",
    });
  });

  it.each([
    ["other method", { method: "GET" }],
    ["other path", { path: "/api/agent/policy" }],
    ["other body", { body: '{"activeSeats":999}' }],
  ])("rejects a signature made for a different request: %s", async (_n, change) => {
    const r = signed();
    const forged = { ...r, ...("method" in change ? { method: change.method } : {}) };
    const res = await verifyAgentRequest({
      method: forged.method,
      pathAndQuery: "path" in change ? change.path! : r.path,
      headers: r.headers,
      body: "body" in change ? Buffer.from(change.body!) : r.body,
      now: at(v.timestamp),
      lookupKey: lookup,
      nonces: new MemoryNonceStore(),
    });
    expect(res).toMatchObject({ ok: false, status: 401, reason: "bad signature" });
  });

  it("rejects clock skew beyond five minutes either way", async () => {
    for (const now of [v.timestamp + 301, v.timestamp - 301]) {
      const r = signed();
      const res = await verifyAgentRequest({
        method: r.method,
        pathAndQuery: r.path,
        headers: r.headers,
        body: r.body,
        now: at(now),
        lookupKey: lookup,
        nonces: new MemoryNonceStore(),
      });
      expect(res).toMatchObject({ ok: false, status: 401 });
    }
  });

  it("rejects unknown servers and malformed headers", async () => {
    const r = signed();
    const unknown = await verifyAgentRequest({
      method: r.method,
      pathAndQuery: r.path,
      headers: r.headers,
      body: r.body,
      now: at(v.timestamp),
      lookupKey: async () => null,
      nonces: new MemoryNonceStore(),
    });
    expect(unknown).toMatchObject({ ok: false, status: 401, reason: "unknown or revoked server" });
    for (const [k, bad] of [
      [HEADERS.server, "../../etc"],
      [HEADERS.timestamp, "soon"],
      [HEADERS.nonce, "short"],
      [HEADERS.signature, ""],
    ] as const) {
      const h = new Headers(r.headers);
      h.set(k, bad);
      const res = await verifyAgentRequest({
        method: r.method,
        pathAndQuery: r.path,
        headers: h,
        body: r.body,
        now: at(v.timestamp),
        lookupKey: lookup,
        nonces: new MemoryNonceStore(),
      });
      expect(res).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("a bad signature does not burn the nonce", async () => {
    const nonces = new MemoryNonceStore();
    const r = signed();
    const h = new Headers(r.headers);
    h.set(HEADERS.signature, Buffer.alloc(64).toString("base64"));
    const base = {
      method: r.method,
      pathAndQuery: r.path,
      body: r.body,
      now: at(v.timestamp),
      lookupKey: lookup,
      nonces,
    };
    expect(await verifyAgentRequest({ ...base, headers: h })).toMatchObject({ reason: "bad signature" });
    expect(await verifyAgentRequest({ ...base, headers: r.headers })).toMatchObject({ ok: true });
  });

  it("verifySignature rejects wrong-length keys and signatures", () => {
    expect(verifySignature("AAAA", v.canonical, v.signatureBase64)).toBe(false);
    expect(verifySignature(v.publicKeyBase64, v.canonical, "AAAA")).toBe(false);
  });
});
