// Releases and rollout rings (docs/UPDATES.md §1 step 9, §2).
//  * POST /api/releases: the release workflow registers a signed release (ring 0).
//  * GET /api/agent/releases: a server asks which release it should stage.
//  * promote: Off Manual staff move a release to ring 1 (pilot) or 2 (all).
import { timingSafeEqual } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { firms, releaseRings, releases, servers } from "@/db/schema";
import { requireConsole, type SessionState } from "./auth";
import type { DB } from "./db";
import { uuidv7 } from "./ids";

export interface ReleaseDeps {
  db: DB;
  now: () => Date;
  registerToken?: string | undefined; // OM_RELEASE_REGISTER_TOKEN
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

/** Staff promote a release to a wider ring (UPDATES §2). */
export async function promote(deps: ReleaseDeps, s: SessionState | null, version: string, ring: number) {
  const p = requireConsole(s, ["superadmin"]);
  if (![1, 2].includes(ring)) throw new Error("ring must be 1 or 2");
  const r = (await deps.db.select().from(releases).where(eq(releases.version, version)))[0];
  if (!r) throw new Error("unknown release");
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
