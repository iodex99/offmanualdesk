import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { open, seal, loadKey } from "../lib/secretbox";
import { base32Decode, base32Encode, hotp, newSecret, provisioningUri, verifyTotp } from "../lib/totp";

describe("TOTP (RFC 4226 / 6238)", () => {
  it("HOTP vectors", () => {
    const key = Buffer.from("12345678901234567890");
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => hotp(key, c))).toEqual([
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ]);
  });
  it("TOTP vectors (8 digits, SHA-1/256/512)", () => {
    const seeds = {
      sha1: Buffer.from("12345678901234567890"),
      sha256: Buffer.from("12345678901234567890123456789012"),
      sha512: Buffer.from("1234567890123456789012345678901234567890123456789012345678901234"),
    } as const;
    const cases: [number, keyof typeof seeds, string][] = [
      [59, "sha1", "94287082"],
      [59, "sha256", "46119246"],
      [59, "sha512", "90693936"],
      [1111111109, "sha1", "07081804"],
      [1234567890, "sha256", "91819424"],
      [20000000000, "sha512", "47863826"],
    ];
    for (const [t, alg, code] of cases) expect(hotp(seeds[alg], Math.floor(t / 30), 8, alg)).toBe(code);
  });
  it("base32 round trip and secret size", () => {
    const b = randomBytes(20);
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    expect(base32Decode(newSecret())).toHaveLength(20);
    expect(() => base32Decode("1!")).toThrow();
  });
  it("verify: window, replay, malformed", () => {
    const secret = newSecret();
    const now = new Date("2026-11-22T10:00:15Z");
    const step = Math.floor(now.getTime() / 30000);
    const prev = hotp(base32Decode(secret), step - 1);
    const r = verifyTotp(secret, prev, now);
    expect(r).toEqual({ ok: true, counter: step - 1 });
    expect(verifyTotp(secret, prev, now, step - 1)).toEqual({ ok: false, reason: "replayed" });
    expect(verifyTotp(secret, hotp(base32Decode(secret), step - 3), now)).toEqual({
      ok: false,
      reason: "invalid",
    });
    for (const bad of ["", "12345", "abcdef", "1234567"]) expect(verifyTotp(secret, bad, now).ok).toBe(false);
    expect(verifyTotp("!!", "123456", now).ok).toBe(false);
  });
  it("provisioning URI", () => {
    const u = new URL(provisioningUri("JBSWY3DPEHPK3PXP", "dwahnil@offmanual.in"));
    expect(u.protocol).toBe("otpauth:");
    expect(u.searchParams.get("issuer")).toBe("Off Manual Console");
  });
});

describe("secretbox", () => {
  const key = randomBytes(32);
  it("round trips and binds the column context", () => {
    const s = seal(key, "JBSWY3DPEHPK3PXP", "console_users.totp_secret_enc");
    expect(s.startsWith("v1.")).toBe(true);
    expect(s).not.toContain("JBSWY3DPEHPK3PXP");
    expect(open(key, s, "console_users.totp_secret_enc")).toBe("JBSWY3DPEHPK3PXP");
    expect(() => open(key, s, "firm_admins.totp_secret_enc")).toThrow();
    expect(() => open(randomBytes(32), s, "console_users.totp_secret_enc")).toThrow();
  });
  it("rejects tampering, empty secrets and bad keys", () => {
    const s = seal(key, "x", "c");
    const parts = s.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => open(key, parts.join("."), "c")).toThrow();
    expect(() => seal(key, "", "c")).toThrow();
    expect(() => loadKey("short")).toThrow();
    expect(loadKey(key.toString("base64"))).toHaveLength(32);
  });
});
