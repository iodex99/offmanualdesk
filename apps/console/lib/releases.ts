// Releases and rollout rings (docs/UPDATES.md §1 step 9, §2).
//  * POST /api/releases: the release workflow registers a signed release (ring 0).
//  * GET /api/agent/releases: a server asks which release it should stage.
//  * promote: Off Manual staff move a release to ring 1 (pilot) or 2 (all); only
//    Authenticode-signed releases leave ring 0 unless explicitly allowed (ADR-057).
//  * setFirmRollout: a firm's ring and version pin (a pin to the previous version is
//    the rollback, UPDATES §4).
import { timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { firms, releaseRings, releases, servers } from "@/db/schema";
import { InputError } from "./admin";
import { requireConsole, type SessionState } from "./auth";
import type { DB } from "./db";
import { uuidv7 } from "./ids";

export interface ReleaseDeps {
  db: DB;
  now: () => Date;
  registerToken?: string | undefined; // OM_RELEASE_REGISTER_TOKEN
  /** OM_ALLOW_UNSIGNED_RELEASES=true: unsigned releases may leave ring 0 (before the signing account exists). */
  allowUnsigned?: boolean;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// Only the fields the console needs; the signed manifest itself stays in the store.
const registerSchema = z
  .object({
    manifest: z
      .object({
        version: z.string().regex(semver),
        severity: z.enum(["normal", "security"]),
        deadlineAt: z.string().optional(),
        openclawVersion: z.string().min(1),
        keyId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
        authenticode: z.boolean().optional(),
        payload: z
          .object({ name: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number() })
          .passthrough(),
      })
      .passthrough(),
    signature: z.object({ keyId: z.string(), sig: z.string() }).passthrough(),
    changelogMd: z.string().max(100_000),
    ring: z.literal(0),
    manifestUrl: z.url().optional(),
  })
  .strict();

function tokenOk(header: string | null, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function registerRelease(deps: ReleaseDeps, req: Request): Promise<Response> {
  if (!tokenOk(req.headers.get("authorization"), deps.registerToken))
    return json(401, { error: "unauthorised" });
  let body;
  try {
    body = registerSchema.parse(await req.json());
  } catch {
    return json(400, { error: "invalid release" });
  }
  const m = body.manifest;
  const id = uuidv7(deps.now().getTime());
  try {
    await deps.db.transaction(async (tx) => {
      await tx.insert(releases).values({
        id,
        version: m.version,
        severity: m.severity,
        deadlineAt: m.deadlineAt ? new Date(m.deadlineAt) : null,
        manifestUrl: body.manifestUrl ?? null,
        payloadSha256: m.payload.sha256,
        keyId: m.keyId,
        authenticode: m.authenticode === true,
        changelogMd: body.changelogMd,
        openclawVersion: m.openclawVersion,
      });
      await tx.insert(releaseRings).values({ releaseId: id, ring: 0 });
    });
  } catch {
    return json(409, { error: "release already registered" });
  }
  return json(201, { id, version: m.version, ring: 0 });
}

const UNSIGNED =
  "This release isn't Authenticode-signed, so it stays in the lab ring. Sign releases (Azure Trusted Signing) or set OM_ALLOW_UNSIGNED_RELEASES=true for the pilot.";

/** Staff promote a release to a wider ring (UPDATES §2). */
export async function promote(deps: ReleaseDeps, s: SessionState | null, version: string, ring: number) {
  const p = requireConsole(s, ["superadmin"]);
  if (![1, 2].includes(ring)) throw new InputError("A release can be moved to ring 1 (pilot) or 2 (all).");
  const r = (await deps.db.select().from(releases).where(eq(releases.version, version)))[0];
  if (!r) throw new InputError("There is no release with that version (unknown release).");
  if (!r.authenticode && !deps.allowUnsigned) throw new InputError(UNSIGNED);
  await deps.db
    .insert(releaseRings)
    .values({ releaseId: r.id, ring, promotedBy: p.userId })
    .onConflictDoNothing();
}

const cmpSemver = (a: string, b: string) => {
  const pa = a.split(/[.-]/).slice(0, 3).map(Number);
  const pb = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  return 0;
};

/**
 * The release a server should run: the firm's pinned version if set, else the newest
 * release promoted to a ring ≥ the firm's ring (ring 0 = lab, 1 = pilot, 2 = all).
 */
export async function assignedRelease(db: DB, serverUuid: string) {
  const srv = (
    await db.select({ firmId: servers.firmId }).from(servers).where(eq(servers.id, serverUuid))
  )[0];
  if (!srv) return null;
  const firm = (
    await db
      .select({ ring: firms.rolloutRing, pin: firms.versionPin })
      .from(firms)
      .where(eq(firms.id, srv.firmId))
  )[0];
  if (!firm) return null;
  if (firm.pin) {
    return (await db.select().from(releases).where(eq(releases.version, firm.pin)))[0] ?? null;
  }
  const eligible = await db
    .select({ r: releases })
    .from(releases)
    .innerJoin(releaseRings, and(eq(releaseRings.releaseId, releases.id), gte(releaseRings.ring, firm.ring)))
    .orderBy(desc(releases.createdAt));
  const unique = [...new Map(eligible.map((e) => [e.r.id, e.r])).values()];
  unique.sort((a, b) => cmpSemver(b.version, a.version));
  return unique[0] ?? null;
}

const versionSchema = z.string().regex(semver);
const rolloutSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("promote"), version: versionSchema, ring: z.number().int() }).strict(),
  z
    .object({
      action: z.literal("rollout"),
      firmId: z.string().uuid(),
      ring: z.number().int().min(0).max(2),
      pin: versionSchema.nullable(),
    })
    .strict(),
]);

/**
 * A firm's ring (0 lab, 1 pilot, 2 all) and optional version pin. Pinning to the
 * previous version is the rollback; clearing the pin returns the firm to its ring.
 */
export async function setFirmRollout(
  deps: ReleaseDeps,
  s: SessionState | null,
  firmId: string,
  ring: number,
  pin: string | null,
) {
  requireConsole(s, ["superadmin"]);
  if (![0, 1, 2].includes(ring)) throw new InputError("Ring must be 0 (lab), 1 (pilot) or 2 (all).");
  if (pin !== null) {
    const r = (await deps.db.select().from(releases).where(eq(releases.version, pin)))[0];
    if (!r) throw new InputError("There is no release with that version (unknown release).");
    if (!r.authenticode && !deps.allowUnsigned && ring !== 0) throw new InputError(UNSIGNED);
  }
  const done = await deps.db
    .update(firms)
    .set({ rolloutRing: ring, versionPin: pin })
    .where(eq(firms.id, firmId))
    .returning({ id: firms.id });
  if (done.length === 0) throw new InputError("There is no such firm.");
}

/** POST /api/admin/releases (superadmin). */
export async function releaseAction(deps: ReleaseDeps, s: SessionState | null, body: unknown) {
  requireConsole(s, ["superadmin"]);
  const r = rolloutSchema.safeParse(body);
  if (!r.success) throw new InputError("Some details are missing or not in the right format.");
  const a = r.data;
  if (a.action === "promote") {
    await promote(deps, s, a.version, a.ring);
    return { ok: true };
  }
  await setFirmRollout(deps, s, a.firmId, a.ring, a.pin);
  return { ok: true };
}

/** The releases page: every release with its rings and how many servers run or staged it, and each firm's ring and pin. */
export async function releasesBoard(deps: ReleaseDeps, s: SessionState | null) {
  requireConsole(s, ["superadmin"]);
  const rel = await deps.db.select().from(releases);
  const rings = await deps.db.select().from(releaseRings);
  const srv = await deps.db
    .select({ agent: servers.agentVersion, staged: servers.stagedVersion })
    .from(servers);
  const firmRows = await deps.db
    .select({
      id: firms.id,
      name: firms.name,
      status: firms.status,
      ring: firms.rolloutRing,
      pin: firms.versionPin,
    })
    .from(firms)
    .orderBy(asc(firms.name));
  rel.sort((a, b) => cmpSemver(b.version, a.version));
  return {
    releases: rel.map((r) => ({
      version: r.version,
      severity: r.severity,
      deadlineAt: r.deadlineAt,
      authenticode: r.authenticode,
      openclawVersion: r.openclawVersion,
      createdAt: r.createdAt,
      rings: rings
        .filter((x) => x.releaseId === r.id)
        .map((x) => x.ring)
        .sort(),
      running: srv.filter((x) => x.agent === r.version).length,
      staged: srv.filter((x) => x.staged === r.version && x.agent !== r.version).length,
    })),
    firms: firmRows,
    allowUnsigned: deps.allowUnsigned === true,
  };
}
