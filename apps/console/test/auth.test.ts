import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consoleUsers, firmAdmins, firms, sessions } from "@/db/schema";
import {
  AuthError,
  createSession,
  destroySession,
  getSession,
  principalByEmail,
  requireConsole,
  requireFirmAccess,
  totpEnrolStart,
  totpEnrolled,
  totpVerify,
  type AuthDeps,
} from "@/lib/auth";
import type { DB } from "@/lib/db";
import { uuidv7 } from "@/lib/ids";
import { base32Decode, hotp } from "@/lib/totp";
import { testDb } from "./helpers/db";

let db: DB;
let close: () => Promise<void>;
let deps: AuthDeps;
let clock: Date;
let firmA: string;
let firmB: string;

const codeAt = (secret: string, at: Date) => hotp(base32Decode(secret), Math.floor(at.getTime() / 30000));

beforeEach(async () => {
  ({ db, close } = await testDb());
  clock = new Date("2026-11-22T10:00:00Z");
  deps = { db, now: () => clock, dataKey: randomBytes(32) };
  firmA = uuidv7();
  firmB = uuidv7();
  await db.insert(firms).values([
    { id: firmA, name: "Mehta", legalName: "Mehta LLP", stateCode: "27", billingEmail: "a@a.in" },
    { id: firmB, name: "Shah", legalName: "Shah LLP", stateCode: "24", billingEmail: "b@b.in" },
  ]);
  await db
    .insert(consoleUsers)
    .values({ id: uuidv7(), email: "dwahnil@offmanual.in", name: "Dwahnil", role: "superadmin" });
  await db
    .insert(firmAdmins)
    .values({ id: uuidv7(), firmId: firmA, email: "admin@mehta.in", name: "Office Manager" });
});
afterEach(async () => close());

describe("principals", () => {
  it("finds console users and firm admins by verified email (case-insensitive)", async () => {
    expect(await principalByEmail(db, "Dwahnil@OffManual.in")).toMatchObject({
      kind: "console",
      role: "superadmin",
    });
    expect(await principalByEmail(db, "admin@mehta.in")).toMatchObject({ kind: "firm_admin", firmId: firmA });
    expect(await principalByEmail(db, "stranger@gmail.com")).toBeNull();
  });
  it("refuses an email that is admin of two firms (ambiguous)", async () => {
    await db
      .insert(firmAdmins)
      .values({ id: uuidv7(), firmId: firmB, email: "admin@mehta.in", name: "Same person" });
    expect(await principalByEmail(db, "admin@mehta.in")).toBeNull();
  });
});

describe("sessions + mandatory TOTP", () => {
  it("pre-MFA session has no access; enrolment then TOTP grants a 12 h session", async () => {
    const p = (await principalByEmail(db, "admin@mehta.in"))!;
    const token = await createSession(deps, p);
    let s = await getSession(deps, token);
    expect(s?.mfa).toBe(false);
    expect(() => requireFirmAccess(s, firmA)).toThrow(AuthError);

    expect(await totpEnrolled(deps, p)).toBe(false);
    const { secret, uri } = await totpEnrolStart(deps, s!);
    expect(uri).toContain("otpauth://totp/");
    const stored = (await db.select().from(firmAdmins).where(eq(firmAdmins.id, p.userId)))[0]!;
    expect(stored.totpSecretEnc).not.toContain(secret); // encrypted at rest

    await expect(totpVerify(deps, s!, "000000")).rejects.toMatchObject({ status: 401 });
    await totpVerify(deps, s!, codeAt(secret, clock));
    s = await getSession(deps, token);
    expect(s?.mfa).toBe(true);
    expect(await totpEnrolled(deps, p)).toBe(true);
    expect(requireFirmAccess(s, firmA)).toMatchObject({ kind: "firm_admin" });

    // Session lasts 12 hours, then ends.
    clock = new Date(clock.getTime() + 11 * 3600e3);
    expect(await getSession(deps, token)).not.toBeNull();
    clock = new Date(clock.getTime() + 2 * 3600e3);
    expect(await getSession(deps, token)).toBeNull();
  });

  it("a used code can't be replayed for a second session", async () => {
    const p = (await principalByEmail(db, "dwahnil@offmanual.in"))!;
    const s1 = (await getSession(deps, await createSession(deps, p)))!;
    const { secret } = await totpEnrolStart(deps, s1);
    const code = codeAt(secret, clock);
    await totpVerify(deps, s1, code);
    const s2 = (await getSession(deps, await createSession(deps, p)))!;
    await expect(totpVerify(deps, s2, code)).rejects.toMatchObject({ status: 401 });
    await expect(totpEnrolStart(deps, s2)).rejects.toMatchObject({ status: 409 });
  });

  it("pre-MFA sessions expire after 10 minutes", async () => {
    const p = (await principalByEmail(db, "admin@mehta.in"))!;
    const token = await createSession(deps, p);
    clock = new Date(clock.getTime() + 11 * 60e3);
    expect(await getSession(deps, token)).toBeNull();
  });

  it("disabling a user ends their access immediately; logout deletes the session", async () => {
    const p = (await principalByEmail(db, "admin@mehta.in"))!;
    const token = await createSession(deps, p);
    await db.update(firmAdmins).set({ disabledAt: clock }).where(eq(firmAdmins.id, p.userId));
    expect(await getSession(deps, token)).toBeNull();
    const cu = (await principalByEmail(db, "dwahnil@offmanual.in"))!;
    const t2 = await createSession(deps, cu);
    await destroySession(deps, t2);
    expect(await db.select().from(sessions).where(eq(sessions.userId, cu.userId))).toHaveLength(0);
    expect(await getSession(deps, "x".repeat(200))).toBeNull();
  });
});

describe("authorisation", () => {
  const full = (principal: object) => ({ principal, mfa: true, token: "t" }) as never;
  it("firm admins only reach their own firm; staff reach every firm", () => {
    const admin = full({
      kind: "firm_admin",
      userId: "u",
      email: "e",
      name: "n",
      role: "admin",
      firmId: "A",
    });
    expect(() => requireFirmAccess(admin, "A")).not.toThrow();
    expect(() => requireFirmAccess(admin, "B")).toThrow(/don't have access to this firm/);
    expect(() => requireConsole(admin)).toThrow(AuthError);
    const staff = full({ kind: "console", userId: "u", email: "e", name: "n", role: "staff" });
    expect(() => requireFirmAccess(staff, "B")).not.toThrow();
    expect(() => requireConsole(staff, ["superadmin"])).toThrow(/don't have access/);
    expect(() => requireConsole(null)).toThrow(/sign in/);
  });
});
