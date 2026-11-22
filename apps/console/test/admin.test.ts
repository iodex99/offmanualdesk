import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  employees,
  enrolmentCodes,
  firmPolicies,
  invites,
  packGrants,
  servers,
  skillPacks,
} from "@/db/schema";
import {
  addEmployee,
  createEnrolmentCode,
  createFirm,
  firmOverview,
  fleet,
  grantPack,
  InputError,
  listEmployees,
  listFirms,
  newEnrolmentCode,
  resendInvite,
  setEmployeeStatus,
  updatePolicy,
  type AdminDeps,
} from "@/lib/admin";
import { hashCode } from "@/lib/agent-api";
import { AuthError, type SessionState } from "@/lib/auth";
import type { DB } from "@/lib/db";
import { uuidv7 } from "@/lib/ids";
import { testDb } from "./helpers/db";

let db: DB;
let close: () => Promise<void>;
let deps: AdminDeps;
const NOW = new Date("2026-11-22T10:00:00Z");

const staff: SessionState = {
  principal: { kind: "console", userId: "u1", email: "d@om.in", name: "D", role: "superadmin" },
  mfa: true,
  token: "t",
};
const adminOf = (firmId: string): SessionState => ({
  principal: { kind: "firm_admin", userId: "u2", email: "a@f.in", name: "A", role: "admin", firmId },
  mfa: true,
  token: "t",
});
const preMfa: SessionState = { ...staff, mfa: false };

const firmBody = {
  name: "Mehta & Co",
  legalName: "Mehta and Co LLP",
  stateCode: "27",
  billingEmail: "accounts@mehta.in",
  gstin: "27AAPFM1234C1Z5",
};

beforeEach(async () => {
  ({ db, close } = await testDb());
  deps = { db, now: () => NOW };
  await db.insert(skillPacks).values([
    { key: "core", name: "Core" },
    { key: "tally-post", name: "Tally post" },
  ]);
});
afterEach(async () => close());

describe("firms and enrolment codes (staff only)", () => {
  it("staff create firms (with a default policy) and one-time codes", async () => {
    const { id } = await createFirm(deps, staff, firmBody);
    expect((await db.select().from(firmPolicies).where(eq(firmPolicies.firmId, id)))[0]).toMatchObject({
      telegramMode: "text",
      version: 1,
    });
    const { code } = await createEnrolmentCode(deps, staff, id, "RDS01");
    expect(code).toMatch(/^OM-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const row = (await db.select().from(enrolmentCodes))[0]!;
    expect(row.codeHash).toBe(hashCode(code));
    expect(JSON.stringify(row)).not.toContain(code);
  });
  it("firm admins and pre-MFA sessions can't", async () => {
    const { id } = await createFirm(deps, staff, firmBody);
    await expect(createFirm(deps, adminOf(id), firmBody)).rejects.toBeInstanceOf(AuthError);
    await expect(createEnrolmentCode(deps, adminOf(id), id, "X")).rejects.toBeInstanceOf(AuthError);
    await expect(createFirm(deps, preMfa, firmBody)).rejects.toBeInstanceOf(AuthError);
  });
  it("validates input strictly", async () => {
    await expect(createFirm(deps, staff, { ...firmBody, gstin: "BAD" })).rejects.toBeInstanceOf(InputError);
    await expect(createFirm(deps, staff, { ...firmBody, isAdmin: true })).rejects.toBeInstanceOf(InputError);
  });
  it("codes avoid look-alike characters", () => {
    for (let i = 0; i < 50; i++) expect(newEnrolmentCode().slice(3)).not.toMatch(/[01OIL]/);
  });
});

describe("firm scoping", () => {
  let a: string;
  let b: string;
  beforeEach(async () => {
    a = (await createFirm(deps, staff, firmBody)).id;
    b = (await createFirm(deps, staff, { ...firmBody, name: "Shah", gstin: undefined })).id;
  });

  it("listFirms: staff see all, a firm admin sees only theirs", async () => {
    expect((await listFirms(deps, staff)).map((f) => f.id).sort()).toEqual([a, b].sort());
    expect((await listFirms(deps, adminOf(a))).map((f) => f.id)).toEqual([a]);
  });

  it("employees: add, list, disable within own firm; never across firms", async () => {
    const { id: asha } = await addEmployee(deps, adminOf(a), a, {
      name: "Asha",
      email: "Asha@Mehta.in",
      windowsSid: "S-1-5-21-1-2-3-1101",
    });
    expect(await db.select().from(invites).where(eq(invites.employeeId, asha))).toHaveLength(1);
    expect((await listEmployees(deps, adminOf(a), a)).map((e) => e.email)).toEqual(["asha@mehta.in"]);
    await expect(addEmployee(deps, adminOf(a), a, { name: "Dup", email: "asha@mehta.in" })).rejects.toThrow(
      /already in this firm/,
    );

    await expect(listEmployees(deps, adminOf(b), a)).rejects.toBeInstanceOf(AuthError);
    await expect(addEmployee(deps, adminOf(b), a, { name: "X", email: "x@x.in" })).rejects.toBeInstanceOf(
      AuthError,
    );
    // Admin of B passing their own firm ID with A's employee: refused, row untouched.
    await expect(setEmployeeStatus(deps, adminOf(b), b, asha, "disabled")).rejects.toBeInstanceOf(AuthError);
    expect((await db.select().from(employees).where(eq(employees.id, asha)))[0]!.status).toBe("invited");

    const before = (await db.select().from(firmPolicies).where(eq(firmPolicies.firmId, a)))[0]!.version;
    await setEmployeeStatus(deps, adminOf(a), a, asha, "disabled");
    const after = (await db.select().from(firmPolicies).where(eq(firmPolicies.firmId, a)))[0]!.version;
    expect((await db.select().from(employees).where(eq(employees.id, asha)))[0]!.status).toBe("disabled");
    expect(after).toBe(before + 1);
  });

  it("pack grants: per employee or AD group, own firm only", async () => {
    const { id: asha } = await addEmployee(deps, adminOf(a), a, { name: "Asha", email: "asha@mehta.in" });
    await grantPack(deps, adminOf(a), a, { packKey: "core", employeeId: asha });
    await grantPack(deps, adminOf(a), a, { packKey: "tally-post", adGroup: "OM-TallyPost" });
    expect(await db.select().from(packGrants).where(eq(packGrants.firmId, a))).toHaveLength(2);
    await expect(
      grantPack(deps, adminOf(b), b, { packKey: "core", employeeId: asha }),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      grantPack(deps, adminOf(a), a, { packKey: "nope", employeeId: asha }),
    ).rejects.toBeInstanceOf(InputError);
    await expect(
      grantPack(deps, adminOf(a), a, { packKey: "core", employeeId: asha, adGroup: "OM-X" }),
    ).rejects.toBeInstanceOf(InputError);
    await expect(
      grantPack(deps, adminOf(a), a, { packKey: "core", adGroup: "Domain Admins" }),
    ).rejects.toBeInstanceOf(InputError);
  });

  it("policy updates are validated and bump the version", async () => {
    await updatePolicy(deps, adminOf(a), a, { telegramMode: "off", lockTimeoutMaxMin: 10 });
    const p = (await db.select().from(firmPolicies).where(eq(firmPolicies.firmId, a)))[0]!;
    expect(p).toMatchObject({ telegramMode: "off", lockTimeoutMaxMin: 10, version: 2 });
    await expect(updatePolicy(deps, adminOf(a), a, { telegramMode: "everything" })).rejects.toBeInstanceOf(
      InputError,
    );
    await expect(updatePolicy(deps, adminOf(a), a, { totpRequired: false })).rejects.toBeInstanceOf(
      InputError,
    );
    await expect(updatePolicy(deps, adminOf(b), a, { telegramMode: "off" })).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it("fleet board: staff only; silent servers turn red", async () => {
    await db.insert(servers).values([
      {
        id: uuidv7(),
        firmId: a,
        hostname: "RDS01",
        publicKey: "k1",
        enrolledAt: NOW,
        lastHeartbeatAt: new Date(NOW.getTime() - 60e3),
        health: "green",
      },
      {
        id: uuidv7(),
        firmId: b,
        hostname: "RDS02",
        publicKey: "k2",
        enrolledAt: NOW,
        lastHeartbeatAt: new Date(NOW.getTime() - 2 * 3600e3),
        health: "green",
      },
      { id: uuidv7(), firmId: b, hostname: "OLD", publicKey: "k3", enrolledAt: NOW, revokedAt: NOW },
    ]);
    const rows = await fleet(deps, staff);
    expect(rows.map((r) => [r.hostname, r.health])).toEqual([
      ["RDS01", "green"],
      ["RDS02", "red"],
    ]);
    await expect(fleet(deps, adminOf(a))).rejects.toBeInstanceOf(AuthError);
  });
});

describe("firm page overview", () => {
  it("staff and the firm's own admin see it; other firms' admins and pre-MFA sessions don't", async () => {
    const { id } = await createFirm(deps, staff, firmBody);
    const { id: other } = await createFirm(deps, staff, { ...firmBody, name: "Shah", gstin: undefined });
    const { id: emp } = await addEmployee(deps, staff, id, { name: "Asha", email: "asha@mehta.in" });
    await grantPack(deps, staff, id, { packKey: "core", employeeId: emp });
    await updatePolicy(deps, staff, id, { stepUpActions: ["review.approve"] });

    const o = await firmOverview(deps, adminOf(id), id);
    expect(o).toMatchObject({
      firm: { id, name: "Mehta & Co", status: "trial" },
      isStaff: false,
      policy: { stepUpActions: ["review.approve"] },
      grants: [{ packKey: "core", employeeId: emp, adGroup: null }],
    });
    expect(o.packs.map((p) => p.key)).toEqual(["core", "tally-post"]);
    expect(o.policy!.version).toBeGreaterThan(1); // every change bumps the agent ETag
    expect((await firmOverview(deps, staff, id)).isStaff).toBe(true);
    await expect(firmOverview(deps, adminOf(other), id)).rejects.toBeInstanceOf(AuthError);
    await expect(firmOverview(deps, preMfa, id)).rejects.toMatchObject({ status: 401 });
    await expect(firmOverview(deps, staff, uuidv7())).rejects.toBeInstanceOf(InputError);
  });
});

describe("invite email", () => {
  const mailer = () => {
    const sent: { to: string; key: string }[] = [];
    let fail = false;
    return {
      sent,
      setFail: (f: boolean) => (fail = f),
      m: {
        async send(e: { to: string; idempotencyKey: string }) {
          if (fail) throw new Error("down");
          sent.push({ to: e.to, key: e.idempotencyKey });
        },
      },
    };
  };

  it("adding an employee sends the invite and records it; failures don't undo the add", async () => {
    const { id: firmId } = await createFirm(deps, staff, firmBody);
    const ml = mailer();
    const d = { ...deps, mailer: ml.m, baseUrl: "https://console.test" };
    const a = await addEmployee(d, adminOf(firmId), firmId, { name: "Asha", email: "Asha@Mehta.in" });
    expect(a.inviteSent).toBe(true);
    expect(ml.sent).toEqual([{ to: "asha@mehta.in", key: expect.stringMatching(/^invite-/) }]);
    expect((await db.select().from(invites).where(eq(invites.employeeId, a.id)))[0]!.sentAt).toEqual(NOW);

    ml.setFail(true);
    const b = await addEmployee(d, adminOf(firmId), firmId, { name: "Ravi", email: "ravi@mehta.in" });
    expect(b.inviteSent).toBe(false);
    expect(await db.select().from(employees).where(eq(employees.id, b.id))).toHaveLength(1);
    expect((await db.select().from(invites).where(eq(invites.employeeId, b.id)))[0]!.sentAt).toBeNull();

    const c = await addEmployee(deps, adminOf(firmId), firmId, { name: "Neha", email: "neha@mehta.in" });
    expect(c.inviteSent).toBe(false); // email not configured

    ml.setFail(false);
    expect(await resendInvite(d, adminOf(firmId), firmId, b.id)).toEqual({ sent: true });
    expect(ml.sent.map((x) => x.to)).toContain("ravi@mehta.in");
    await expect(resendInvite(deps, adminOf(firmId), firmId, c.id)).rejects.toThrow(/isn't set up/);
  });

  it("resend is firm-scoped and only for people who haven't signed in", async () => {
    const { id: firmId } = await createFirm(deps, staff, firmBody);
    const { id: other } = await createFirm(deps, staff, { ...firmBody, name: "Shah", gstin: undefined });
    const ml = mailer();
    const d = { ...deps, mailer: ml.m, baseUrl: "https://console.test" };
    const a = await addEmployee(d, staff, firmId, { name: "Asha", email: "asha@mehta.in" });
    await expect(resendInvite(d, adminOf(other), firmId, a.id)).rejects.toBeInstanceOf(AuthError);
    await expect(resendInvite(d, adminOf(other), other, a.id)).rejects.toThrow(/isn't in this firm/);
    await db.update(employees).set({ status: "active" }).where(eq(employees.id, a.id));
    await expect(resendInvite(d, staff, firmId, a.id)).rejects.toThrow(/already signed in/);
  });
});
