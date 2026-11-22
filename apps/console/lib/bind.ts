// Employee ↔ Windows account binding (ARCHITECTURE F2, ADR-044).
//
// 1. The employee signs in on the console with Google/Microsoft (verified email).
// 2. The console shows a one-time code (10 min) for that employee.
// 3. The employee types it into Desk; the Server Agent sends it with the caller's
//    OS-derived SID (rule 4) in a signed request; the console binds that SID.
//
// The code only travels from the console page to the employee's own Desk, so a
// phished link can't bind someone else's employee record to an attacker's account.
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { bindCodes, employees, invites, packGrants } from "@/db/schema";
import type { DB } from "./db";
import { uuidv7 } from "./ids";
import type { VerifiedIdentity } from "./oidc";

export const BIND_CODE_TTL_MS = 10 * 60 * 1000;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
const SID = /^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-\d{1,10}$/;

export interface BindDeps {
  db: DB;
  now: () => Date;
}

/** Normalises what the employee typed: upper case, no spaces or dashes. */
export function normaliseBindCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

export function hashBindCode(code: string): string {
  return createHash("sha256")
    .update(`bind:${normaliseBindCode(code)}`)
    .digest("hex");
}

/** 8 characters shown as XXXX-XXXX. */
export function newBindCode(): string {
  const b = randomBytes(8);
  const s = [...b].map((x) => ALPHABET[x % ALPHABET.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export class BindError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** After employee sign-in: a fresh code for the one employee with this verified email. */
export async function createBindCode(
  deps: BindDeps,
  id: VerifiedIdentity,
): Promise<{ code: string; name: string }> {
  const email = id.email.trim().toLowerCase();
  const rows = await deps.db
    .select({
      id: employees.id,
      name: employees.name,
      oauthProvider: employees.oauthProvider,
      oauthSubject: employees.oauthSubject,
    })
    .from(employees)
    .where(and(sql`lower(${employees.email}) = ${email}`, ne(employees.status, "disabled")));
  if (rows.length === 0) {
    throw new BindError(404, "This email isn't set up for Off Manual. Ask your firm's admin to invite you.");
  }
  if (rows.length > 1) {
    throw new BindError(409, "This email is set up more than once. Ask your firm's admin to fix it.");
  }
  const e = rows[0]!;
  // Once bound to a sign-in account, the same Google/Microsoft account must be used.
  if (e.oauthSubject && (e.oauthProvider !== id.provider || e.oauthSubject !== id.subject)) {
    throw new BindError(409, "Sign in with the same Google or Microsoft account you used before.");
  }
  const code = newBindCode();
  const now = deps.now();
  await deps.db.delete(bindCodes).where(and(eq(bindCodes.employeeId, e.id), isNull(bindCodes.usedAt)));
  await deps.db.insert(bindCodes).values({
    id: uuidv7(),
    employeeId: e.id,
    codeHash: hashBindCode(code),
    oauthProvider: id.provider,
    oauthSubject: id.subject,
    expiresAt: new Date(now.getTime() + BIND_CODE_TTL_MS),
  });
  return { code, name: e.name };
}

export interface BoundEmployee {
  employeeId: string;
  name: string;
  status: "active";
  packs: string[];
}

/**
 * Redeems a code for a server of `firmId` and binds `sid`. Same plain message for
 * unknown, used, expired and other-firm codes (no oracle).
 */
export async function redeemBindCode(
  deps: BindDeps,
  firmId: string,
  rawCode: string,
  sid: string,
): Promise<BoundEmployee> {
  const invalid = new BindError(404, "That code isn't valid or has expired. Sign in again to get a new one.");
  if (!SID.test(sid)) throw new BindError(400, "invalid request");
  const code = normaliseBindCode(rawCode);
  if (!/^[A-Z2-9]{8}$/.test(code)) throw invalid;
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const row = (
      await tx
        .select({
          id: bindCodes.id,
          employeeId: bindCodes.employeeId,
          provider: bindCodes.oauthProvider,
          subject: bindCodes.oauthSubject,
          firmId: employees.firmId,
          name: employees.name,
          status: employees.status,
          sid: employees.windowsSid,
        })
        .from(bindCodes)
        .innerJoin(employees, eq(employees.id, bindCodes.employeeId))
        .where(
          and(
            eq(bindCodes.codeHash, hashBindCode(code)),
            isNull(bindCodes.usedAt),
            gt(bindCodes.expiresAt, now),
          ),
        )
    )[0];
    if (!row || row.firmId !== firmId || row.status === "disabled") throw invalid;
    if (row.sid && row.sid !== sid) {
      throw new BindError(
        409,
        "Your Off Manual account is already linked to a different Windows account. Ask your admin to reset it.",
      );
    }
    const other = await tx
      .select({ id: employees.id })
      .from(employees)
      .where(
        and(eq(employees.firmId, firmId), eq(employees.windowsSid, sid), ne(employees.id, row.employeeId)),
      );
    if (other.length > 0) {
      throw new BindError(409, "This Windows account is already linked to someone else. Ask your admin.");
    }
    // Single use even under a race: only one redeemer flips used_at.
    const used = await tx
      .update(bindCodes)
      .set({ usedAt: now })
      .where(and(eq(bindCodes.id, row.id), isNull(bindCodes.usedAt)))
      .returning({ id: bindCodes.id });
    if (used.length !== 1) throw invalid;
    await tx
      .update(employees)
      .set({
        windowsSid: sid,
        boundAt: now,
        status: "active",
        oauthProvider: row.provider,
        oauthSubject: row.subject,
        updatedAt: now,
      })
      .where(eq(employees.id, row.employeeId));
    await tx
      .update(invites)
      .set({ acceptedAt: now })
      .where(and(eq(invites.employeeId, row.employeeId), isNull(invites.acceptedAt)));
    const packs = await tx
      .select({ key: packGrants.packKey })
      .from(packGrants)
      .where(and(eq(packGrants.firmId, firmId), eq(packGrants.employeeId, row.employeeId)));
    return {
      employeeId: row.employeeId,
      name: row.name,
      status: "active" as const,
      packs: [...new Set(packs.map((p) => p.key))].sort(),
    };
  });
}
