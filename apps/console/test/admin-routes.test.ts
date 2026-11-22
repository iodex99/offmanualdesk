import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consoleUsers, sessions } from "@/db/schema";
import { createFirm, listFirms } from "@/lib/admin";
import { adminHandler } from "@/lib/admin-routes";
import { createSession, SESSION_COOKIE, type AuthDeps } from "@/lib/auth";
import type { DB } from "@/lib/db";
import { uuidv7 } from "@/lib/ids";
import { testDb } from "./helpers/db";

let db: DB;
let close: () => Promise<void>;
let deps: AuthDeps;
let token: string;

beforeEach(async () => {
  ({ db, close } = await testDb());
  deps = { db, now: () => new Date("2026-11-22T10:00:00Z"), dataKey: randomBytes(32) };
  const id = uuidv7();
  await db.insert(consoleUsers).values({ id, email: "d@om.in", name: "D", role: "superadmin" });
  token = await createSession(deps, {
    kind: "console",
    userId: id,
    email: "d@om.in",
    name: "D",
    role: "superadmin",
  });
  await db
    .update(sessions)
    .set({ mfaAt: new Date("2026-11-22T10:00:00Z"), expiresAt: new Date("2026-11-22T20:00:00Z") });
});
afterEach(async () => close());

const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("https://console.test/api/admin/firms", {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${token}`, ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

const firm = { name: "Mehta", legalName: "Mehta LLP", stateCode: "27", billingEmail: "a@m.in" };

describe("adminHandler", () => {
  it("runs the operation with the session and returns JSON", async () => {
    const res = await adminHandler(deps, req("POST", firm, { "content-type": "application/json" }), (s, b) =>
      createFirm({ db, now: deps.now }, s, b),
    );
    expect(res.status).toBe(200);
    const list = await adminHandler(deps, req("GET"), (s) => listFirms({ db, now: deps.now }, s));
    expect(((await list.json()) as unknown[]).length).toBe(1);
  });
  it("refuses non-JSON mutations (CSRF guard) and malformed JSON", async () => {
    const form = await adminHandler(
      deps,
      req("POST", "name=x", { "content-type": "application/x-www-form-urlencoded" }),
      async () => "should not run",
    );
    expect(form.status).toBe(415);
    const bad = await adminHandler(
      deps,
      req("POST", "{not json", { "content-type": "application/json" }),
      async () => "x",
    );
    expect(bad.status).toBe(400);
  });
  it("maps auth and input errors to plain responses", async () => {
    const noSession = await adminHandler(deps, new Request("https://console.test/x"), (s) =>
      listFirms({ db, now: deps.now }, s),
    );
    expect(noSession.status).toBe(401);
    const invalid = await adminHandler(
      deps,
      req("POST", { name: "x" }, { "content-type": "application/json" }),
      (s, b) => createFirm({ db, now: deps.now }, s, b),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "Some details are missing or not in the right format." });
  });
});
