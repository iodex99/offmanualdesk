// UUIDv7 (RFC 9562 §5.7): 48-bit Unix ms timestamp, version 7, variant 10, random rest.
// Time-ordered IDs keep Postgres indexes compact (docs/DATA_MODEL.md §1).
import { randomBytes } from "node:crypto";

export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Public server ID used in X-OM-Server: "srv_" + uuid hex without dashes. */
export function serverPublicId(uuid: string): string {
  return `srv_${uuid.replaceAll("-", "")}`;
}

/** Inverse of serverPublicId; null when malformed. */
export function serverUuid(publicId: string): string | null {
  const m = /^srv_([0-9a-f]{32})$/.exec(publicId);
  if (!m) return null;
  const h = m[1]!;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
