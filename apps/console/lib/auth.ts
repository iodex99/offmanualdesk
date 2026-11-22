// Console sign-in (ADR-037): OIDC (Google / Microsoft) identifies the person by a
// verified email; TOTP is then mandatory before any page or API works. Sessions are
// server-side; the cookie holds a random token, the database only its sha256.
//
// Roles: console users are superadmin | staff (all firms); firm admins are scoped to
// their own firm and can never read another firm's rows (.claude/rules/console.md).
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { consoleUsers, firmAdmins, sessions } from "@/db/schema";
import type { DB } from "./db";
import { open, seal } from "./secretbox";
import { newSecret, provisioningUri, verifyTotp } from "./totp";

export const SESSION_COOKIE = "om_session";
export const PRE_MFA_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type Principal =
  | { kind: "console"; userId: string; email: string; name: string; role: "superadmin" | "staff" }
  | {
      kind: "firm_admin";
      userId: string;
      email: string;
      name: string;
      role: "owner" | "admin";
      firmId: string;
    };

export interface AuthDeps {
  db: DB;
  now: () => Date;
  dataKey: Buffer;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Finds the active principal for a verified email. Console users win over firm admins. */
export async function principalByEmail(db: DB, email: string): Promise<Principal | null> {
  const e = email.trim().toLowerCase();
  const cu = (
    await db
      .select()
      .from(consoleUsers)
      .where(and(eq(consoleUsers.email, e), isNull(consoleUsers.disabledAt)))
  )[0];
  if (cu) return { kind: "console", userId: cu.id, email: cu.email, name: cu.name, role: cu.role };
  const fa = await db
    .select()
    .from(firmAdmins)
    .where(and(eq(firmAdmins.email, e), isNull(firmAdmins.disabledAt)));
  if (fa.length !== 1) return null; // unknown, or ambiguous across firms (refuse rather than guess)
  const a = fa[0]!;
  return { kind: "firm_admin", userId: a.id, email: a.email, name: a.name, role: a.role, firmId: a.firmId };
}

async function loadPrincipal(
  db: DB,
  kind: "console" | "firm_admin",
  userId: string,
): Promise<Principal | null> {
  if (kind === "console") {
    const cu = (
      await db
        .select()
        .from(consoleUsers)
        .where(and(eq(consoleUsers.id, userId), isNull(consoleUsers.disabledAt)))
    )[0];
    return cu ? { kind, userId, email: cu.email, name: cu.name, role: cu.role } : null;
  }
  const a = (
    await db
      .select()
      .from(firmAdmins)
      .where(and(eq(firmAdmins.id, userId), isNull(firmAdmins.disabledAt)))
  )[0];
  return a ? { kind, userId, email: a.email, name: a.name, role: a.role, firmId: a.firmId } : null;
}

/** Creates a pre-MFA session and returns the cookie token (shown once). */
export async function createSession(deps: AuthDeps, p: Principal): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = deps.now();
  await deps.db.delete(sessions).where(lt(sessions.expiresAt, now));
  await deps.db.insert(sessions).values({
    tokenHash: sha256(token),
    kind: p.kind,
    userId: p.userId,
    expiresAt: new Date(now.getTime() + PRE_MFA_TTL_MS),
  });
  return token;
}

export type SessionState = { principal: Principal; mfa: boolean; token: string };

/** Resolves a cookie token. Disabled users lose access immediately. */
export async function getSession(deps: AuthDeps, token: string | undefined): Promise<SessionState | null> {
  if (!token || token.length > 100) return null;
  const row = (
    await deps.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, deps.now())))
  )[0];
  if (!row) return null;
  const principal = await loadPrincipal(deps.db, row.kind, row.userId);
  if (!principal) return null;
  return { principal, mfa: row.mfaAt !== null, token };
}

export async function destroySession(deps: AuthDeps, token: string): Promise<void> {
  await deps.db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}

// ---- TOTP (mandatory; firm admins can't turn it off, rule 9) ----

function totpTable(p: Principal) {
  return p.kind === "console" ? consoleUsers : firmAdmins;
}
function totpContext(p: Principal) {
  return p.kind === "console" ? "console_users.totp_secret_enc" : "firm_admins.totp_secret_enc";
}

async function totpRow(deps: AuthDeps, p: Principal) {
  const t = totpTable(p);
  const rows = await deps.db
    .select({ enc: t.totpSecretEnc, enrolledAt: t.totpEnrolledAt, last: t.totpLastCounter })
    .from(t)
    .where(eq(t.id, p.userId));
  return rows[0];
}

/** Starts (or restarts, while unconfirmed) TOTP enrolment. */
export async function totpEnrolStart(
  deps: AuthDeps,
  s: SessionState,
): Promise<{ secret: string; uri: string }> {
  const row = await totpRow(deps, s.principal);
  if (row?.enrolledAt) throw new AuthError(409, "Your authenticator is already set up.");
  const secret = newSecret();
  const t = totpTable(s.principal);
  await deps.db
    .update(t)
    .set({ totpSecretEnc: seal(deps.dataKey, secret, totpContext(s.principal)), totpLastCounter: 0 })
    .where(eq(t.id, s.principal.userId));
  return { secret, uri: provisioningUri(secret, s.principal.email) };
}

/** Confirms enrolment or verifies a code; on success the session gets full access. */
export async function totpVerify(deps: AuthDeps, s: SessionState, code: string): Promise<void> {
  const row = await totpRow(deps, s.principal);
  if (!row?.enc) throw new AuthError(409, "Set up your authenticator first.");
  const secret = open(deps.dataKey, row.enc, totpContext(s.principal));
  const r = verifyTotp(secret, code, deps.now(), row.last);
  if (!r.ok)
    throw new AuthError(
      401,
      r.reason === "replayed" ? "That code was already used. Enter the next one." : "That code isn't right.",
    );
  const t = totpTable(s.principal);
  const now = deps.now();
  await deps.db
    .update(t)
    .set({ totpLastCounter: r.counter, ...(row.enrolledAt ? {} : { totpEnrolledAt: now }) })
    .where(eq(t.id, s.principal.userId));
  await deps.db
    .update(sessions)
    .set({ mfaAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
    .where(eq(sessions.tokenHash, sha256(s.token)));
}

export async function totpEnrolled(deps: AuthDeps, p: Principal): Promise<boolean> {
  return Boolean((await totpRow(deps, p))?.enrolledAt);
}

// ---- authorisation ----

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** Requires a fully signed-in (MFA) principal, optionally of given console roles. */
export function requireConsole(
  s: SessionState | null,
  roles: ("superadmin" | "staff")[] = ["superadmin", "staff"],
) {
  if (!s || !s.mfa) throw new AuthError(401, "Please sign in.");
  if (s.principal.kind !== "console" || !roles.includes(s.principal.role)) {
    throw new AuthError(403, "You don't have access to this page.");
  }
  return s.principal;
}

/**
 * Requires access to one firm: Off Manual staff (any firm) or that firm's own admin.
 * Every firm-scoped query goes through this with the firm ID from the URL.
 */
export function requireFirmAccess(s: SessionState | null, firmId: string) {
  if (!s || !s.mfa) throw new AuthError(401, "Please sign in.");
  const p = s.principal;
  if (p.kind === "console") return p;
  if (p.firmId !== firmId) throw new AuthError(403, "You don't have access to this firm.");
  return p;
}
