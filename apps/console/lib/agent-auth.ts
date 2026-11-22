// Verifies Server Agent requests (ADR-013, ADR-035). Every /api/agent/* route calls
// verifyAgentRequest before doing anything else (.claude/rules/console.md).
// Canonical string must match apps/server-agent/internal/console/sign.go; both
// sides test against packages/shared-schema/fixtures/agent-signature.json.
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

export const SIGNATURE_VERSION = "OM-AGENT-1";
export const MAX_SKEW_SECONDS = 300;
export const HEADERS = {
  server: "x-om-server",
  timestamp: "x-om-timestamp",
  nonce: "x-om-nonce",
  signature: "x-om-signature",
} as const;

// DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410): SEQUENCE{SEQUENCE{OID 1.3.101.112}, BIT STRING}
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function canonical(
  method: string,
  pathAndQuery: string,
  serverId: string,
  timestamp: number,
  nonce: string,
  body: Uint8Array,
): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return [
    SIGNATURE_VERSION,
    method.toUpperCase(),
    pathAndQuery,
    serverId,
    String(timestamp),
    nonce,
    bodyHash,
  ].join("\n");
}

export function verifySignature(publicKeyBase64: string, message: string, signatureBase64: string): boolean {
  const raw = Buffer.from(publicKeyBase64, "base64");
  const sig = Buffer.from(signatureBase64, "base64");
  if (raw.length !== 32 || sig.length !== 64) return false;
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
  return cryptoVerify(null, Buffer.from(message, "utf8"), key, sig);
}

/** Remembers nonces for the skew window so a captured request can't be replayed. */
export interface NonceStore {
  /** Returns false if (serverId, nonce) was already used. */
  useOnce(serverId: string, nonce: string, expiresAt: Date, now: Date): Promise<boolean>;
}

export interface ServerKeyLookup {
  /** Public key (base64 raw ed25519) of an enrolled, non-revoked server, or null. */
  (serverId: string): Promise<string | null>;
}

export type AgentAuthResult =
  { ok: true; serverId: string } | { ok: false; status: 400 | 401; reason: string };

const SERVER_ID_RE = /^srv_[a-z0-9]{8,40}$/;
const NONCE_RE = /^[0-9a-f]{16,64}$/;

export async function verifyAgentRequest(input: {
  method: string;
  pathAndQuery: string;
  headers: Headers;
  body: Uint8Array;
  now: Date;
  lookupKey: ServerKeyLookup;
  nonces: NonceStore;
}): Promise<AgentAuthResult> {
  const h = input.headers;
  const serverId = h.get(HEADERS.server) ?? "";
  const tsRaw = h.get(HEADERS.timestamp) ?? "";
  const nonce = h.get(HEADERS.nonce) ?? "";
  const signature = h.get(HEADERS.signature) ?? "";
  if (!SERVER_ID_RE.test(serverId) || !/^\d{1,12}$/.test(tsRaw) || !NONCE_RE.test(nonce) || !signature) {
    return { ok: false, status: 400, reason: "missing or malformed signature headers" };
  }
  const ts = Number(tsRaw);
  const nowSec = Math.floor(input.now.getTime() / 1000);
  if (Math.abs(nowSec - ts) > MAX_SKEW_SECONDS) {
    return { ok: false, status: 401, reason: "timestamp outside the allowed window" };
  }
  const key = await input.lookupKey(serverId);
  if (!key) return { ok: false, status: 401, reason: "unknown or revoked server" };
  const msg = canonical(input.method, input.pathAndQuery, serverId, ts, nonce, input.body);
  if (!verifySignature(key, msg, signature)) return { ok: false, status: 401, reason: "bad signature" };
  // Only after the signature checks out, so attackers can't burn nonces.
  const fresh = await input.nonces.useOnce(
    serverId,
    nonce,
    new Date((ts + MAX_SKEW_SECONDS) * 1000),
    input.now,
  );
  if (!fresh) return { ok: false, status: 401, reason: "replayed request" };
  return { ok: true, serverId };
}

/** In-memory nonce store for tests and single-instance development. */
export class MemoryNonceStore implements NonceStore {
  private seen = new Map<string, number>();
  async useOnce(serverId: string, nonce: string, expiresAt: Date, at: Date): Promise<boolean> {
    const now = at.getTime();
    for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k);
    const k = `${serverId}:${nonce}`;
    if (this.seen.has(k)) return false;
    this.seen.set(k, expiresAt.getTime());
    return true;
  }
}
