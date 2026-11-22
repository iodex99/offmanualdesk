// Management operations for Off Manual staff and firm admins. Every function
// authorises first (requireConsole / requireFirmAccess) and validates input strictly.
// Firm admins can only touch their own firm (.claude/rules/console.md).
import { randomBytes } from "node:crypto";
import { and, asc, eq, gte, sql } from "drizzle-orm";
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
  supportTickets,
} from "@/db/schema";
import { hashCode } from "./agent-api";
import { AuthError, requireConsole, requireFirmAccess, type SessionState } from "./auth";
import type { DB } from "./db";
import { inviteEmail, type Mailer } from "./email";
import { uuidv7 } from "./ids";

export interface AdminDeps {
  db: DB;
  now: () => Date;
  /** Invite email; null/absent until RESEND_API_KEY is configured. */
  mailer?: Mailer | null;
  baseUrl?: string;
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
    taskRole: z.enum(["article", "senior", "manager", "partner"]).optional(),
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
  const inviteId = uuidv7();
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
        taskRole: e.taskRole ?? null,
        status: "invited",
      });
      await tx.insert(invites).values({ id: inviteId, employeeId: id, channel: e.inviteChannel });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new InputError("Someone with that email or Windows account is already in this firm.");
    }
    throw err;
  }
  await bumpPolicy(deps.db, firmId);
  return { id, inviteSent: await sendInvite(deps, firmId, inviteId, e.name, e.email, e.inviteChannel) };
}

/** Sends the invite email; failure never undoes adding the employee (the admin can resend). */
async function sendInvite(
  deps: AdminDeps,
  firmId: string,
  inviteId: string,
  name: string,
  email: string,
  channel: "email" | "whatsapp",
): Promise<boolean> {
  if (channel !== "email" || !deps.mailer || !deps.baseUrl) return false;
  const firm = (await deps.db.select({ name: firms.name }).from(firms).where(eq(firms.id, firmId)))[0];
  try {
    await deps.mailer.send(
      inviteEmail({ to: email, name, firm: firm?.name ?? "Your firm", consoleUrl: deps.baseUrl, inviteId }),
    );
  } catch {
    return false;
  }
  await deps.db.update(invites).set({ sentAt: deps.now() }).where(eq(invites.id, inviteId));
  return true;
}

/** Re-sends an employee's invite email (e.g. after email was configured or it bounced). */
export async function resendInvite(
  deps: AdminDeps,
  s: SessionState | null,
  firmId: string,
  employeeId: string,
) {
  requireFirmAccess(s, firmId);
  const row = (
    await deps.db
      .select({
        name: employees.name,
        email: employees.email,
        status: employees.status,
        inviteId: invites.id,
      })
      .from(employees)
      .innerJoin(invites, eq(invites.employeeId, employees.id))
      .where(and(eq(employees.id, employeeId), eq(employees.firmId, firmId)))
  )[0];
  if (!row) throw new InputError("That employee isn't in this firm.");
  if (row.status !== "invited") throw new InputError("This person has already signed in.");
  if (!deps.mailer) throw new InputError("Email isn't set up for the console yet.");
  const sent = await sendInvite(deps, firmId, row.inviteId, row.name, row.email, "email");
  if (!sent) throw new InputError("The email couldn't be sent. Check the address and try again later.");
  return { sent: true };
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
      taskRole: employees.taskRole,
    })
    .from(employees)
    .where(eq(employees.firmId, firmId))
    .orderBy(asc(employees.name));
}

export const TASK_ROLES = ["article", "senior", "manager", "partner"] as const;

/** Which task buttons Desk shows first for this employee (SKILLS.md §5, ADR-061); null = all in the usual order. */
export async function setTaskRole(
  deps: AdminDeps,
  s: SessionState | null,
  firmId: string,
  employeeId: string,
  input: unknown,
) {
  requireFirmAccess(s, firmId);
  const { taskRole } = parse(z.object({ taskRole: z.enum(TASK_ROLES).nullable() }).strict(), input);
  const updated = await deps.db
    .update(employees)
    .set({ taskRole, updatedAt: deps.now() })
    .where(and(eq(employees.id, employeeId), eq(employees.firmId, firmId)))
    .returning({ id: employees.id });
  if (updated.length !== 1) throw new InputError("That employee isn't in this firm.");
  await bumpPolicy(deps.db, firmId);
  return { ok: true };
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
  await deps.db.insert(packGrants).values({
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
  firmId: string;
  firm: string;
  firmStatus: string;
  hostname: string;
  health: "green" | "amber" | "red";
  lastHeartbeatAt: Date | null;
  agentVersion: string | null;
  openclawVersion: string | null;
  deskVersion: string | null;
  stagedVersion: string | null;
  activeSeats: number;
  /** Problem reports from this server in the last 7 days (F11). */
  reports7d: number;
};

/** Servers with effective health: red when no heartbeat for over an hour. */
export async function fleet(deps: AdminDeps, s: SessionState | null): Promise<FleetRow[]> {
  requireConsole(s);
  const rows = await deps.db
    .select({
      serverId: servers.id,
      firmId: firms.id,
      firm: firms.name,
      firmStatus: firms.status,
      hostname: servers.hostname,
      health: servers.health,
      lastHeartbeatAt: servers.lastHeartbeatAt,
      agentVersion: servers.agentVersion,
      openclawVersion: servers.openclawVersion,
      deskVersion: servers.deskVersion,
      stagedVersion: servers.stagedVersion,
      activeSeats: servers.activeSeats,
      revokedAt: servers.revokedAt,
    })
    .from(servers)
    .innerJoin(firms, eq(firms.id, servers.firmId))
    .orderBy(asc(firms.name), asc(servers.hostname));
  const stale = deps.now().getTime() - 3600e3;
  const weekAgo = new Date(deps.now().getTime() - 7 * 86400e3);
  const reports = await deps.db
    .select({ serverId: supportTickets.serverId, n: sql<number>`count(*)::int` })
    .from(supportTickets)
    .where(gte(supportTickets.createdAt, weekAgo))
    .groupBy(supportTickets.serverId);
  const reportsBy = new Map(reports.map((r) => [r.serverId, r.n]));
  return rows
    .filter((r) => !r.revokedAt)
    .map(({ revokedAt: _r, ...r }) => ({
      ...r,
      health: !r.lastHeartbeatAt || r.lastHeartbeatAt.getTime() < stale ? "red" : r.health,
      reports7d: reportsBy.get(r.serverId) ?? 0,
    }));
}

// ---- firm page (staff, or that firm's own admin) ----

/** Everything the firm page shows except employees and invoices (their own loaders). */
export async function firmOverview(deps: AdminDeps, s: SessionState | null, firmId: string) {
  const p = requireFirmAccess(s, firmId);
  const firm = (
    await deps.db
      .select({ id: firms.id, name: firms.name, status: firms.status, stateCode: firms.stateCode })
      .from(firms)
      .where(eq(firms.id, firmId))
  )[0];
  if (!firm) throw new InputError("That firm doesn't exist.");
  const policy =
    (await deps.db.select().from(firmPolicies).where(eq(firmPolicies.firmId, firmId)))[0] ?? null;
  const grants = await deps.db
    .select({
      id: packGrants.id,
      packKey: packGrants.packKey,
      adGroup: packGrants.adGroup,
      employeeId: packGrants.employeeId,
    })
    .from(packGrants)
    .where(eq(packGrants.firmId, firmId));
  const packs = await deps.db
    .select({ key: skillPacks.key, name: skillPacks.name })
    .from(skillPacks)
    .orderBy(asc(skillPacks.key));
  return {
    firm,
    isStaff: p.kind === "console",
    policy: policy && {
      lockTimeoutMaxMin: policy.lockTimeoutMaxMin,
      dayEndHourIst: policy.dayEndHourIst,
      telegramMode: policy.telegramMode,
      telegramUnlockMaxMin: policy.telegramUnlockMaxMin,
      stepUpActions: policy.stepUpActions,
      gatewayIdleStopHours: policy.gatewayIdleStopHours,
      retentionDays: policy.retentionDays,
      version: policy.version,
    },
    grants,
    packs,
  };
}

/**
 * Resets an employee's authenticator (lost phone and recovery codes; ADR-049). The
 * Server Agent applies it at the next policy sync: TOTP, recovery codes and the day
 * grant are cleared, so the employee enrols again from their own Windows session.
 */
export async function resetAuthenticator(
  deps: AdminDeps,
  s: SessionState | null,
  firmId: string,
  employeeId: string,
) {
  requireFirmAccess(s, firmId);
  const now = deps.now();
  const updated = await deps.db
    .update(employees)
    .set({ totpResetAt: now, updatedAt: now })
    .where(and(eq(employees.id, employeeId), eq(employees.firmId, firmId), eq(employees.status, "active")))
    .returning({ id: employees.id });
  if (updated.length !== 1) throw new InputError("Only an active employee of this firm can be reset.");
  await bumpPolicy(deps.db, firmId);
  return { ok: true };
}
