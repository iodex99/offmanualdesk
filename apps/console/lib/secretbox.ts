// Encrypts secrets at rest (TOTP secrets) with AES-256-GCM. The 32-byte key comes
// from OM_DATA_KEY (base64) in the Vercel environment. Format: v1.<iv>.<tag>.<ct>
// (base64url). The column name is passed as associated data, so a ciphertext copied
// into another column fails to decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function loadKey(b64 = process.env.OM_DATA_KEY): Buffer {
  const key = Buffer.from(b64 ?? "", "base64");
  if (key.length !== 32) throw new Error("OM_DATA_KEY must be 32 bytes, base64");
  return key;
}

export function seal(key: Buffer, plaintext: string, context: string): string {
  if (!plaintext) throw new Error("refusing to encrypt an empty secret");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(context));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    c.getAuthTag().toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

export function open(key: Buffer, sealed: string, context: string): string {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("unsupported secret format");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(context));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
