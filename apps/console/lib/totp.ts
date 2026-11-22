// TOTP for console users and firm admins (RFC 6238; same parameters as the Server
// Agent, ADR-030: SHA-1, 6 digits, 30 s, ±1 step, replay protection).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("invalid base32");
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(
  key: Uint8Array,
  counter: number,
  digits = 6,
  alg: "sha1" | "sha256" | "sha512" = "sha1",
): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(alg, key).update(msg).digest();
  const off = mac[mac.length - 1]! & 0x0f;
  const bin = mac.readUInt32BE(off) & 0x7fffffff;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const counterAt = (unixSeconds: number, period = 30) => Math.floor(unixSeconds / period);

export type VerifyResult = { ok: true; counter: number } | { ok: false; reason: "invalid" | "replayed" };

/** Verifies a 6-digit code at `now` (±1 step). Codes at or below lastUsed are replays. */
export function verifyTotp(secret: string, code: string, now: Date, lastUsed = 0): VerifyResult {
  const c = code.trim();
  if (!/^\d{6}$/.test(c)) return { ok: false, reason: "invalid" };
  let key: Buffer;
  try {
    key = base32Decode(secret);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const cur = counterAt(Math.floor(now.getTime() / 1000));
  let matched = -1;
  for (const step of [cur - 1, cur, cur + 1]) {
    if (step < 0) continue;
    const want = Buffer.from(hotp(key, step));
    if (timingSafeEqual(want, Buffer.from(c)) && step > matched) matched = step;
  }
  if (matched < 0) return { ok: false, reason: "invalid" };
  if (lastUsed && matched <= lastUsed) return { ok: false, reason: "replayed" };
  return { ok: true, counter: matched };
}

export function provisioningUri(secret: string, account: string): string {
  const label = encodeURIComponent(`Off Manual Console:${account}`);
  const q = new URLSearchParams({
    secret,
    issuer: "Off Manual Console",
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}
