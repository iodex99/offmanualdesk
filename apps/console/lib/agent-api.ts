// Agent API handlers (docs/ARCHITECTURE.md §3.3). Pure functions of (deps, Request)
// so they run against PGlite in tests and postgres.js in production.
//
// Rules (.claude/rules/console.md): verify the signature before anything else;
// strict bodies (unknown fields rejected); never accept client content: only
// versions, health, counts.
import { createHash } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  agentNonces,
  auditSummaries,
  employees,
  enrolmentCodes,
  firmPolicies,
  firms,
  packGrants,
  servers,
} from "@/db/schema";
import type { DB } from "./db";
import { canonical, HEADERS, verifyAgentRequest, verifySignature, type NonceStore } from "./agent-auth";
import { serverPublicId, serverUuid, uuidv7 } from "./ids";

export interface Deps {
  db: DB;
  now: () => Date;
}

export const MAX_BODY_BYTES = 256 * 1024;
export const ENROLMENT_SERVER_ID = "srv_enrollment";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const fail = (status: number, message: string) => json(status, { error: message });

async function readBody(req: Request): Promise<Uint8Array | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) return null;
  const buf = new Uint8Array(await req.arrayBuffer());
  return buf.byteLength > MAX_BODY_BYTES ? null : buf;
}

function pathAndQuery(req: Request): string {
  const u = new URL(req.url);
  return u.pathname + u.search;
}

function parseJson<T>(schema: z.ZodType<T>, body: Uint8Array): T | null {
  try {
    const r = schema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return r.success ? r.data : null;
  } catch {
    // Malformed JSON is the client's error; the caller answers 400.
    return null;
  }
}

/** Postgres-backed nonce store (ADR-035). */
export function dbNonceStore(db: DB): NonceStore {
  return {
    async useOnce(serverId, nonce, expiresAt, now) {
      const id = serverUuid(serverId);
      if (!id) return false;
      await db.delete(agentNonces).where(lt(agentNonces.expiresAt, now));
      const inserted = await db
        .insert(agentNonces)
        .values({ serverId: id, nonce, expiresAt })
        .onConflictDoNothing()
        .returning({ nonce: agentNonces.nonce });
      return inserted.length === 1;
    },
  };
}

type Authed =
  { ok: true; serverUuid: string; firmId: string; body: Uint8Array } | { ok: false; res: Response };

/** Verifies the signed request and loads the calling server. Always the first step. */
async function authenticate(deps: Deps, req: Request): Promise<Authed> {
  const body = await readBody(req);
  if (!body) return { ok: false, res: fail(413, "body too large") };
  const res = await verifyAgentRequest({
    method: req.method,
    pathAndQuery: pathAndQuery(req),
    headers: req.headers,
    body,
    now: deps.now(),
    lookupKey: async (publicId) => {
      const id = serverUuid(publicId);
      if (!id) return null;
      const rows = await deps.db
        .select({ key: servers.publicKey })
        .from(servers)
        .where(and(eq(servers.id, id), isNull(servers.revokedAt)));
      return rows[0]?.key ?? null;
    },
    nonces: dbNonceStore(deps.db),
  });
  if (!res.ok) return { ok: false, res: fail(res.status, res.reason) };
  const id = serverUuid(res.serverId)!;
  const rows = await deps.db.select({ firmId: servers.firmId }).from(servers).where(eq(servers.id, id));
  if (!rows[0]) return { ok: false, res: fail(401, "unknown or revoked server") };
  return { ok: true, serverUuid: id, firmId: rows[0].firmId, body };
}

// ---- POST /api/agent/enroll ----

const preflightSchema = z
  .object({
    overall: z.enum(["pass", "warn", "fail"]),
    results: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9_]{1,32}$/),
            title: z.string().max(80),
            status: z.enum(["pass", "skip", "warn", "fail"]),
            detail: z.string().max(200),
            fix: z.string().max(300).optional(),
          })
          .strict(),
      )
      .max(40),
    at: z.string().max(40),
  })
  .strict();

const enrollSchema = z
  .object({
    code: z.string().regex(/^[A-Z0-9-]{8,32}$/),
    publicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
    hostname: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/),
    agentVersion: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
    preflight: preflightSchema.optional(),
  })
  .strict();

export function hashCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

export async function enroll(deps: Deps, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (!body) return fail(413, "body too large");
  const input = parseJson(enrollSchema, body);
  if (!input) return fail(400, "invalid enrolment request");
  // Proof of possession: the request is signed by the key being enrolled.
  const ts = Number(req.headers.get(HEADERS.timestamp) ?? "NaN");
  const nonce = req.headers.get(HEADERS.nonce) ?? "";
  const sig = req.headers.get(HEADERS.signature) ?? "";
  if (
    req.headers.get(HEADERS.server) !== ENROLMENT_SERVER_ID ||
    !Number.isFinite(ts) ||
    !/^[0-9a-f]{16,64}$/.test(nonce)
  ) {
    return fail(400, "missing or malformed signature headers");
  }
  if (Math.abs(Math.floor(deps.now().getTime() / 1000) - ts) > 300)
    return fail(401, "timestamp outside the allowed window");
  const msg = canonical(req.method, pathAndQuery(req), ENROLMENT_SERVER_ID, ts, nonce, body);
  if (!verifySignature(input.publicKey, msg, sig)) return fail(401, "bad signature");

  const now = deps.now();
  const result = await deps.db.transaction(async (tx) => {
    const codes = await tx
      .select()
      .from(enrolmentCodes)
      .where(
        and(
          eq(enrolmentCodes.codeHash, hashCode(input.code)),
          isNull(enrolmentCodes.usedAt),
          gt(enrolmentCodes.expiresAt, now),
        ),
      )
      .for("update");
    const code = codes[0];
    if (!code) return null;
    const id = uuidv7(now.getTime());
    await tx.insert(servers).values({
      id,
      firmId: code.firmId,
      hostname: input.hostname,
      publicKey: input.publicKey,
      enrolledAt: now,
      agentVersion: input.agentVersion,
      preflightJson: input.preflight ?? null,
      health: input.preflight?.overall === "fail" ? "red" : "amber",
    });
    await tx.update(enrolmentCodes).set({ usedAt: now, serverId: id }).where(eq(enrolmentCodes.id, code.id));
    return id;
  });
  if (!result)
    return fail(403, "This enrolment code is not valid or has expired. Ask Off Manual for a new one.");
  return json(201, { serverId: serverPublicId(result) });
}

// ---- POST /api/agent/heartbeat ----

const version = z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
const heartbeatSchema = z
  .object({
    agentVersion: version,
    openclawVersion: z.string().max(32).optional(),
    deskVersion: version.optional(),
    stagedVersion: version.optional(),
    health: z.enum(["green", "amber", "red"]),
    activeSeats: z.number().int().min(0).max(10000),
  })
  .strict();

export async function heartbeat(deps: Deps, req: Request): Promise<Response> {
  const a = await authenticate(deps, req);
  if (!a.ok) return a.res;
  const input = parseJson(heartbeatSchema, a.body);
  if (!input) return fail(400, "invalid heartbeat");
  const now = deps.now();
  await deps.db
    .update(servers)
    .set({
      lastHeartbeatAt: now,
      agentVersion: input.agentVersion,
      openclawVersion: input.openclawVersion ?? null,
      deskVersion: input.deskVersion ?? null,
      stagedVersion: input.stagedVersion ?? null,
      health: input.health,
      activeSeats: input.activeSeats,
      updatedAt: now,
    })
    .where(eq(servers.id, a.serverUuid));
  const firm = (await deps.db.select({ status: firms.status }).from(firms).where(eq(firms.id, a.firmId)))[0];
  const policy = (
    await deps.db
      .select({ version: firmPolicies.version })
      .from(firmPolicies)
      .where(eq(firmPolicies.firmId, a.firmId))
  )[0];
  return json(200, {
    firmStatus: firm?.status ?? "suspended",
    offlineGraceDays: 7,
    policyVersion: policy?.version ?? 0,
    serverTime: now.toISOString(),
  });
}

// ---- GET /api/agent/policy ----

export async function policy(deps: Deps, req: Request): Promise<Response> {
  const a = await authenticate(deps, req);
  if (!a.ok) return a.res;
  const p = (await deps.db.select().from(firmPolicies).where(eq(firmPolicies.firmId, a.firmId)))[0];
  const emps = await deps.db
    .select({
      id: employees.id,
      sid: employees.windowsSid,
      name: employees.name,
      status: employees.status,
      updatedAt: employees.updatedAt,
    })
    .from(employees)
    .where(eq(employees.firmId, a.firmId));
  const grants = await deps.db
    .select({ packKey: packGrants.packKey, adGroup: packGrants.adGroup, employeeId: packGrants.employeeId })
    .from(packGrants)
    .where(eq(packGrants.firmId, a.firmId));
  const latest = Math.max(0, ...emps.map((e) => e.updatedAt.getTime()));
  const etag = `"p${p?.version ?? 0}-e${emps.length}-${latest}-g${grants.length}"`;
  if (req.headers.get("if-none-match") === etag)
    return new Response(null, { status: 304, headers: { etag } });
  const packsFor = (id: string) =>
    [...new Set(grants.filter((g) => g.employeeId === id).map((g) => g.packKey))].sort();
  return json(
    200,
    {
      policyVersion: p?.version ?? 0,
      policy: p
        ? {
            lockTimeoutMaxMin: p.lockTimeoutMaxMin,
            dayEndHourIst: p.dayEndHourIst,
            telegramMode: p.telegramMode,
            telegramUnlockMaxMin: p.telegramUnlockMaxMin,
            telegramAllowedPacks: p.telegramAllowedPacks,
            stepUpActions: p.stepUpActions,
            gatewayIdleStopHours: p.gatewayIdleStopHours,
            retentionDays: p.retentionDays,
          }
        : null,
      adGroupGrants: grants.filter((g) => g.adGroup).map((g) => ({ adGroup: g.adGroup, pack: g.packKey })),
      employees: emps
        .filter((e) => e.sid)
        .map((e) => ({
          employeeId: e.id,
          sid: e.sid,
          name: e.name,
          status: e.status,
          packs: packsFor(e.id),
        })),
    },
    { etag },
  );
}

// ---- POST /api/agent/audit-summary ----

const auditSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    counts: z
      .array(
        z
          .object({ category: z.string().regex(/^[a-z_]{1,32}$/), count: z.number().int().min(0).max(1e7) })
          .strict(),
      )
      .max(64),
  })
  .strict();

export async function auditSummary(deps: Deps, req: Request): Promise<Response> {
  const a = await authenticate(deps, req);
  if (!a.ok) return a.res;
  const input = parseJson(auditSchema, a.body);
  if (!input) return fail(400, "invalid audit summary");
  for (const c of input.counts) {
    await deps.db
      .insert(auditSummaries)
      .values({
        firmId: a.firmId,
        serverId: a.serverUuid,
        date: input.date,
        category: c.category,
        count: c.count,
      })
      .onConflictDoUpdate({
        target: [auditSummaries.serverId, auditSummaries.date, auditSummaries.category],
        set: { count: sql`excluded.count` },
      });
  }
  return json(200, { stored: input.counts.length });
}
