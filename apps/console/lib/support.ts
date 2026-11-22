// Report a problem (ARCHITECTURE F11, ADR-050). The Server Agent uploads a
// metadata-only bundle with the employee's short description; Off Manual staff read
// them on /support. Strict shape and size limits: nothing else is accepted.
import { randomBytes } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { employees, firms, supportTickets } from "@/db/schema";
import { requireConsole, type SessionState } from "./auth";
import type { DB } from "./db";
import { uuidv7 } from "./ids";

export const MAX_REPORTS_PER_SERVER_PER_DAY = 20;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newTicketRef(): string {
  return "OM-" + [...randomBytes(6)].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

const shortString = z.string().max(200);
const preflightResult = z
  .object({
    id: shortString,
    title: shortString,
    status: z.enum(["pass", "skip", "warn", "fail"]),
    detail: z.string().max(500),
    fix: z.string().max(500).optional(),
  })
  .strict();

export const supportBody = z
  .object({
    employeeId: z.string().max(64),
    description: z.string().trim().min(1).max(500),
    bundle: z
      .object({
        server: z
          .object({
            agentVersion: z.string().max(40).optional(),
            stagedVersion: z.string().max(40).optional(),
            policyEtag: z.string().max(100).optional(),
            licence: z.string().max(40).optional(),
            preflight: z
              .object({
                at: z.string().max(40),
                overall: z.enum(["pass", "skip", "warn", "fail"]),
                results: z.array(preflightResult).max(50),
              })
              .strict()
              .optional(),
            logTail: z.array(z.string().max(1000)).max(200).optional(),
          })
          .strict(),
        desk: z.record(
          z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/),
          z.union([z.string().max(120), z.boolean(), z.number(), z.null()]),
        ),
      })
      .strict(),
  })
  .strict();

export type SupportInput = z.infer<typeof supportBody>;

export class SupportLimit extends Error {}

/** Stores one report for a server of `firmId`. The employee must belong to that firm. */
export async function createTicket(
  deps: { db: DB; now: () => Date },
  firmId: string,
  serverUuid: string,
  input: SupportInput,
): Promise<string> {
  const since = new Date(deps.now().getTime() - 24 * 3600 * 1000);
  const recent = (
    await deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(supportTickets)
      .where(and(eq(supportTickets.serverId, serverUuid), gte(supportTickets.createdAt, since)))
  )[0]!.n;
  if (recent >= MAX_REPORTS_PER_SERVER_PER_DAY) {
    throw new SupportLimit("Too many reports from this server today. Please call Off Manual instead.");
  }
  const emp = /^[0-9a-f-]{36}$/.test(input.employeeId)
    ? (
        await deps.db
          .select({ id: employees.id })
          .from(employees)
          .where(and(eq(employees.id, input.employeeId), eq(employees.firmId, firmId)))
      )[0]
    : undefined;
  for (let i = 0; i < 3; i++) {
    const ref = newTicketRef();
    const rows = await deps.db
      .insert(supportTickets)
      .values({
        id: uuidv7(),
        firmId,
        serverId: serverUuid,
        employeeId: emp?.id ?? null,
        ref,
        description: input.description,
        bundle: input.bundle as Record<string, unknown>,
        createdAt: deps.now(),
        updatedAt: deps.now(),
      })
      .onConflictDoNothing()
      .returning({ ref: supportTickets.ref });
    if (rows.length === 1) return ref;
  }
  throw new Error("could not allocate a ticket reference");
}

/** Staff list for /support, newest first. */
export async function listTickets(deps: { db: DB }, s: SessionState | null, limit = 100) {
  requireConsole(s);
  return deps.db
    .select({
      ref: supportTickets.ref,
      firm: firms.name,
      employee: employees.name,
      description: supportTickets.description,
      status: supportTickets.status,
      createdAt: supportTickets.createdAt,
      bundle: supportTickets.bundle,
    })
    .from(supportTickets)
    .innerJoin(firms, eq(firms.id, supportTickets.firmId))
    .leftJoin(employees, eq(employees.id, supportTickets.employeeId))
    .orderBy(desc(supportTickets.createdAt))
    .limit(limit);
}
