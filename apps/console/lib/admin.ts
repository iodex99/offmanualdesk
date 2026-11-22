// Management operations for Off Manual staff and firm admins. Every function
// authorises first (requireConsole / requireFirmAccess) and validates input strictly.
// Firm admins can only touch their own firm (.claude/rules/console.md).
import { randomBytes } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  employees,
  enrolmentCodes,
  firmPolicies,
  firms,
  invites,
  packGrants,
  servers,
  skillPacks,
} from "@/db/schema";
import { hashCode } from "./agent-api";
import { AuthError, requireConsole, requireFirmAccess, type SessionState } from "./auth";
import type { DB } from "./db";
import { uuidv7 } from "./ids";

export interface AdminDeps {
  db: DB;
  now: () => Date;
}

export class InputError extends Error {}

/** Postgres unique_violation (SQLSTATE 23505), possibly wrapped by Drizzle. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new InputError("Some details are missing or not in the right format.");
  return r.data;
}

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const SID = /^S-1-5-21-\d+-\d+-\d+-\d+$/;

// ---- firms (Off Manual staff only) ----

const firmInput = z
  .object({
    name: z.string().trim().min(2).max(120),
    legalName: z.string().trim().min(2).max(200),
    gstin: z.string().regex(GSTIN).optional(),
    stateCode: z.string().regex(/^\d{2}$/),
    billingEmail: z.email(),
    billingPhone: z
      .string()
      .regex(/^\+?\d{10,13}$/)
      .optional(),
  })
  .strict();

export async function createFirm(deps: AdminDeps, s: SessionState | null, input: unknown) {
  requireConsole(s);
  const f = parse(firmInput, input);
  const id = uuidv7(deps.now().getTime());
  await deps.db.transaction(async (tx) => {
    await tx.insert(firms).values({ id, ...f, gstin: f.gstin ?? null, billingPhone: f.billingPhone ?? null });
    await tx.insert(firmPolicies).values({ firmId: id });
  });
  return { id };
}

export async function listFirms(deps: AdminDeps, s: SessionState | null) {
  if (!s?.mfa) throw new AuthError(401, "Please sign in.");
  const q = deps.db.select({ id: firms.id, name: firms.name, status: firms.status }).from(firms);
  return s.principal.kind === "console"
    ? q.orderBy(asc(firms.name))
    : q.where(eq(firms.id, s.principal.firmId)).orderBy(asc(firms.name));
}

// ---- enrolment codes (Off Manual staff) ----

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L

export function newEnrolmentCode(): string {
  const b = randomBytes(12);
  const chars = [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
  return `OM-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export async function createEnrolmentCode(
  deps: AdminDeps,
  s: SessionState | null,
  firmId: string,
  serverName: unknown,
) {
  requireConsole(s);
  const name = parse(z.string().trim().min(1).max(63), serverName);
  const code = newEnrolmentCode();
  await deps.db.insert(enrolmentCodes).values({
    id: uuidv7(),
    firmId,
    serverName: name,
    codeHash: hashCode(code),
    expiresAt: new Date(deps.now().getTime() + 24 * 3600e3),
  });
  // Shown once; only the hash is stored (ADR-036).
  return { code, expiresInHours: 24 };
}

// ---- employees (firm admins + staff) ----

const employeeInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.email().transform((e) => e.toLowerCase()),
    windowsSid: z.string().regex(SID).optional(),
    windowsUsername: z
      .string()
      .regex(/^[A-Za-z0-9._\\-]{1,104}$/)
      .optional(),
    roleLabel: z.string().trim().max(60).optional(),
    inviteChannel: z.enum(["email", "whatsapp"]).default("email"),
  })
  .strict();

async function bumpPolicy(db: AdminDeps["db"], firmId: string) {
  await db
    .update(firmPolicies)
    .set({ version: sql`${firmPolicies.version} + 1`, updatedAt: new Date() })
    .where(eq(firmPolicies.firmId, firmId));
}

export async function addEmployee(deps: AdminDeps, s: SessionState | null, firmId: string, input: unknown) {
  requireFirmAccess(s, firmId);
  const e = parse(employeeInput, input);
  const id = uuidv7(deps.now().getTime());
  try {
    await deps.db.transaction(async (tx) => {
      await tx.insert(employees).values({
        id,
        firmId,
        name: e.name,
        email: e.email,
        windowsSid: e.windowsSid ?? null,
        windowsUsername: e.windowsUsername ?? null,
        roleLabel: e.roleLabel ?? null,
        status: "invited",
      });
      await tx.insert(invites).values({ id: uuidv7(), employeeId: id, channel: e.inviteChannel });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new InputError("Someone with that email or Windows account is already in this firm.");
    }
    throw err;
  }
  await bumpPolicy(deps.db, firmId);
  return { id };
}

export async function listEmployees(deps: AdminDeps, s: SessionState | null, firmId: string) {
  requireFirmAccess(s, firmId);
  return deps.db
    .select({
      id: employees.id,
      name: employees.name,
      email: employees.email,
      status: employees.status,
      boundAt: employees.boundAt,
    })
    .from(employees)
    .where(eq(employees.firmId, firmId))
    .orderBy(asc(employees.name));
}

export async function setEmployeeStatus(
  deps: AdminDeps,
  s: SessionState | null,
  firmId: string,
  employeeId: string,
  status: unknown,
) {
  requireFirmAccess(s, firmId);
  const st = parse(z.enum(["active", "disabled"]), status);
  const res = await deps.db
    .update(employees)
    .set({ status: st, disabledAt: st === "disabled" ? deps.now() : null, updatedAt: deps.now() })
    .where(and(eq(employees.id, employeeId), eq(employees.firmId, firmId)))
    .returning({ id: employees.id });
  if (res.length === 0) throw new AuthError(403, "You don't have access to this employee.");
  await bumpPolicy(deps.db, firmId); // agents pick it up and switch the employee off (F10)
  return { ok: true };
}

// ---- skill packs ----

const grantInput = z
  .object({
    packKey: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
    employeeId: z.uuid().optional(),
    adGroup: z
      .string()
      .regex(/^OM-[A-Za-z0-9-]{1,60}$/)
      .optional(),
  })
  .strict()
  .refine((g) => Boolean(g.employeeId) !== Boolean(g.adGroup), "exactly one of employeeId or adGroup");

export async function grantPack(deps: AdminDeps, s: SessionState | null, firmId: string, input: unknown) {
  requireFirmAccess(s, firmId);
  const g = parse(grantInput, input);
  const pack = (await deps.db.select().from(skillPacks).where(eq(skillPacks.key, g.packKey)))[0];
  if (!pack) throw new InputError("That skill pack doesn't exist.");
  if (g.employeeId) {
    const own = await deps.db
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.id, g.employeeId), eq(employees.firmId, firmId)));
    if (own.length === 0) throw new AuthError(403, "You don't have access to this employee.");
  }
  await deps.db
    .insert(packGrants)
    .values({
      id: uuidv7(),
      firmId,
      packKey: g.packKey,
      employeeId: g.employeeId ?? null,
      adGroup: g.adGroup ?? null,
    });
  await bumpPolicy(deps.db, firmId);
  return { ok: true };
}

// ---- firm policy ----

const policyInput = z
  .object({
    lockTimeoutMaxMin: z.number().int().min(1).max(60),
    dayEndHourIst: z.number().int().min(12).max(23),
    telegramMode: z.enum(["off", "text", "files"]),
    telegramUnlockMaxMin: z.number().int().min(5).max(240),
    stepUpActions: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{1,47}$/)).max(32),
    gatewayIdleStopHours: z.number().int().min(1).max(24),
    retentionDays: z.number().int().min(30).max(3650),
  })
  .partial()
  .strict();

export async function updatePolicy(deps: AdminDeps, s: SessionState | null, firmId: string, input: unknown) {
  requireFirmAccess(s, firmId);
  const p = parse(policyInput, input);
  await deps.db
    .update(firmPolicies)
    .set({ ...p, version: sql`${firmPolicies.version} + 1`, updatedAt: deps.now() })
    .where(eq(firmPolicies.firmId, firmId));
  return { ok: true };
}

// ---- fleet board v0 (Off Manual staff) ----

export type FleetRow = {
  serverId: string;
  firm: string;
  hostname: string;
  health: "green" | "amber" | "red";
  lastHeartbeatAt: Date | null;
  agentVersion: string | null;
  activeSeats: number;
};

/** Servers with effective health: red when no heartbeat for over an hour. */
export async function fleet(deps: AdminDeps, s: SessionState | null): Promise<FleetRow[]> {
  requireConsole(s);
  const rows = await deps.db
    .select({
      serverId: servers.id,
      firm: firms.name,
      hostname: servers.hostname,
      health: servers.health,
      lastHeartbeatAt: servers.lastHeartbeatAt,
      agentVersion: servers.agentVersion,
      activeSeats: servers.activeSeats,
      revokedAt: servers.revokedAt,
    })
    .from(servers)
    .innerJoin(firms, eq(firms.id, servers.firmId))
    .orderBy(asc(firms.name), asc(servers.hostname));
  const stale = deps.now().getTime() - 3600e3;
  return rows
    .filter((r) => !r.revokedAt)
    .map(({ revokedAt: _r, ...r }) => ({
      ...r,
      health: !r.lastHeartbeatAt || r.lastHeartbeatAt.getTime() < stale ? "red" : r.health,
    }));
}
