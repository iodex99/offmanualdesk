import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consoleUsers, firms, releaseRings, servers } from "@/db/schema";
import { AuthError, type SessionState } from "@/lib/auth";
import type { DB } from "@/lib/db";
import { uuidv7 } from "@/lib/ids";
import {
  assignedRelease,
  promote,
  registerRelease,
  releaseAction,
  releasesBoard,
  setFirmRollout,
  type ReleaseDeps,
} from "@/lib/releases";
import { testDb } from "./helpers/db";

let db: DB;
let close: () => Promise<void>;
let deps: ReleaseDeps;
let firmId: string;
let serverId: string;
const TOKEN = "release-register-test-token-0123456789";
const superadmin: SessionState = {
  principal: { kind: "console", userId: uuidv7(), email: "d@om.in", name: "D", role: "superadmin" },
  mfa: true,
  token: "t",
};

const body = (version: string, severity = "normal", authenticode = true) => ({
  manifest: {
    schema: 1,
    version,
    severity,
    openclawVersion: "2026.11.6",
    keyId: "om-rel-2026a",
    authenticode,
    payload: { name: `offmanual-${version}.zip`, sha256: "a".repeat(64), size: 10 },
    files: [],
  },
  signature: { schema: 1, alg: "ed25519", keyId: "om-rel-2026a", sig: "AAAA" },
  changelogMd: "### Added\n- Things.",
  ring: 0,
});

const post = (b: unknown, token = TOKEN) =>
  registerRelease(
    deps,
    new Request("https://console.test/api/releases", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(b),
    }),
  );

beforeEach(async () => {
  ({ db, close } = await testDb());
  deps = { db, now: () => new Date("2026-11-23T00:00:00Z"), registerToken: TOKEN };
  firmId = uuidv7();
  serverId = uuidv7();
  await db.insert(firms).values({
    id: firmId,
    name: "Mehta",
    legalName: "Mehta LLP",
    stateCode: "27",
    billingEmail: "a@m.in",
    rolloutRing: 2,
  });
  await db
    .insert(servers)
    .values({ id: serverId, firmId, hostname: "RDS01", publicKey: "k", enrolledAt: new Date() });
  await db
    .insert(consoleUsers)
    .values({ id: superadmin.principal.userId, email: "d@om.in", name: "D", role: "superadmin" });
});
afterEach(async () => close());

describe("release registration (from the release workflow)", () => {
  it("needs the bearer token and a well-formed body; versions are unique", async () => {
    expect((await post(body("1.0.0"), "wrong-token")).status).toBe(401);
    expect((await post({ ...body("1.0.0"), extra: 1 })).status).toBe(400);
    expect((await post(body("1.0.0"))).status).toBe(201);
    expect((await post(body("1.0.0"))).status).toBe(409);
    const rings = await db.select().from(releaseRings);
    expect(rings.map((r) => r.ring)).toEqual([0]);
  });
  it("refuses everything when no token is configured", async () => {
    deps.registerToken = undefined;
    expect((await post(body("1.0.0"))).status).toBe(401);
  });
});

describe("rings and pins", () => {
  it("a ring-2 firm only sees releases promoted to ring 2; ring 0 sees everything", async () => {
    await post(body("1.0.0"));
    await post(body("1.1.0"));
    expect(await assignedRelease(db, serverId)).toBeNull(); // nothing promoted to all yet
    await promote(deps, superadmin, "1.0.0", 2);
    expect((await assignedRelease(db, serverId))?.version).toBe("1.0.0");
    await db.update(firms).set({ rolloutRing: 0 }).where(eq(firms.id, firmId));
    expect((await assignedRelease(db, serverId))?.version).toBe("1.1.0");
    await promote(deps, superadmin, "1.1.0", 1);
    await db.update(firms).set({ rolloutRing: 1 }).where(eq(firms.id, firmId));
    expect((await assignedRelease(db, serverId))?.version).toBe("1.1.0");
  });
  it("a pinned firm stays on its version (support / rollback)", async () => {
    await post(body("1.0.0"));
    await post(body("1.1.0"));
    await promote(deps, superadmin, "1.1.0", 2);
    await db.update(firms).set({ versionPin: "1.0.0" }).where(eq(firms.id, firmId));
    expect((await assignedRelease(db, serverId))?.version).toBe("1.0.0");
  });
  it("only superadmins promote, only to rings 1 or 2", async () => {
    await post(body("1.0.0"));
    const staff: SessionState = {
      ...superadmin,
      principal: { ...superadmin.principal, role: "staff" } as never,
    };
    await expect(promote(deps, staff, "1.0.0", 2)).rejects.toBeInstanceOf(AuthError);
    await expect(promote(deps, superadmin, "1.0.0", 3)).rejects.toThrow(/ring/);
    await expect(promote(deps, superadmin, "9.9.9", 2)).rejects.toThrow(/unknown/);
  });
});

describe("signing rule (ADR-057)", () => {
  it("an unsigned release stays in ring 0 unless explicitly allowed", async () => {
    await post(body("1.2.0", "normal", false));
    await expect(promote(deps, superadmin, "1.2.0", 1)).rejects.toThrow(/Authenticode/);
    await expect(setFirmRollout(deps, superadmin, firmId, 2, "1.2.0")).rejects.toThrow(/Authenticode/);
    await setFirmRollout(deps, superadmin, firmId, 0, "1.2.0"); // a lab firm may pin it
    deps.allowUnsigned = true;
    await promote(deps, superadmin, "1.2.0", 1);
    await setFirmRollout(deps, superadmin, firmId, 2, "1.2.0");
    expect((await assignedRelease(db, serverId))?.version).toBe("1.2.0");
  });
  it("records the flag from the manifest", async () => {
    await post(body("1.0.0", "normal", true));
    await post(body("1.0.1", "normal", false));
    const b = await releasesBoard(deps, superadmin);
    expect(b.releases.map((r) => [r.version, r.authenticode])).toEqual([
      ["1.0.1", false],
      ["1.0.0", true],
    ]);
  });
});

describe("firm rollout and the board", () => {
  const staff: SessionState = {
    ...superadmin,
    principal: { ...superadmin.principal, role: "staff" } as never,
  };
  it("pin to the previous version rolls back; clearing it follows the ring again", async () => {
    await post(body("1.0.0"));
    await post(body("1.1.0"));
    await releaseAction(deps, superadmin, { action: "promote", version: "1.0.0", ring: 2 });
    await releaseAction(deps, superadmin, { action: "promote", version: "1.1.0", ring: 2 });
    expect((await assignedRelease(db, serverId))?.version).toBe("1.1.0");
    await releaseAction(deps, superadmin, { action: "rollout", firmId, ring: 2, pin: "1.0.0" });
    expect((await assignedRelease(db, serverId))?.version).toBe("1.0.0");
    await releaseAction(deps, superadmin, { action: "rollout", firmId, ring: 2, pin: null });
    expect((await assignedRelease(db, serverId))?.version).toBe("1.1.0");
  });
  it("refuses bad input, unknown versions and firms, and anyone but a superadmin", async () => {
    await post(body("1.0.0"));
    const bad = [
      { action: "rollout", firmId, ring: 3, pin: null },
      { action: "rollout", firmId, ring: 1, pin: "latest" },
      { action: "rollout", firmId, ring: 1 },
      { action: "promote", version: "1.0.0", ring: 2, extra: 1 },
      { action: "delete", version: "1.0.0" },
    ];
    for (const b of bad) await expect(releaseAction(deps, superadmin, b)).rejects.toThrow(/format/);
    await expect(
      releaseAction(deps, superadmin, { action: "rollout", firmId, ring: 1, pin: "9.9.9" }),
    ).rejects.toThrow(/unknown/);
    await expect(
      releaseAction(deps, superadmin, { action: "rollout", firmId: uuidv7(), ring: 1, pin: null }),
    ).rejects.toThrow(/no such firm/);
    await expect(
      releaseAction(deps, staff, { action: "rollout", firmId, ring: 0, pin: null }),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(releasesBoard(deps, staff)).rejects.toBeInstanceOf(AuthError);
    await expect(releasesBoard(deps, null)).rejects.toBeInstanceOf(AuthError);
  });
  it("board lists rings, servers running or staging each version, and firms", async () => {
    await post(body("1.0.0"));
    await post(body("1.1.0"));
    await promote(deps, superadmin, "1.0.0", 2);
    await db
      .update(servers)
      .set({ agentVersion: "1.0.0", stagedVersion: "1.1.0" })
      .where(eq(servers.id, serverId));
    const b = await releasesBoard(deps, superadmin);
    expect(b.releases).toMatchObject([
      { version: "1.1.0", rings: [0], running: 0, staged: 1 },
      { version: "1.0.0", rings: [0, 2], running: 1, staged: 0 },
    ]);
    expect(b.firms).toEqual([{ id: firmId, name: "Mehta", status: "trial", ring: 2, pin: null }]);
    expect(b.allowUnsigned).toBe(false);
  });
});
