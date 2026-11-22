// Firm setup (M10 setup wizard, ADR-054): each server's pre-flight results, and bulk
// import of employees with invites. Everything is firm-scoped on the server.
import { asc, eq } from "drizzle-orm";
import { servers } from "@/db/schema";
import { addEmployee, InputError, type AdminDeps } from "./admin";
import { requireFirmAccess, type SessionState } from "./auth";

export interface PreflightItem {
  id: string;
  title: string;
  status: "pass" | "skip" | "warn" | "fail";
  detail: string;
  fix?: string;
}

/** Servers of a firm with their health and the problems pre-flight found. */
export async function firmServers(deps: AdminDeps, s: SessionState | null, firmId: string) {
  requireFirmAccess(s, firmId);
  const rows = await deps.db
    .select({
      id: servers.id,
      hostname: servers.hostname,
      health: servers.health,
      lastHeartbeatAt: servers.lastHeartbeatAt,
      agentVersion: servers.agentVersion,
      stagedVersion: servers.stagedVersion,
      preflight: servers.preflightJson,
    })
    .from(servers)
    .where(eq(servers.firmId, firmId))
    .orderBy(asc(servers.hostname));
  return rows.map((r) => {
    const pf = (r.preflight ?? null) as { overall?: string; results?: PreflightItem[] } | null;
    const problems = (pf?.results ?? []).filter((x) => x.status === "warn" || x.status === "fail");
    return {
      id: r.id,
      hostname: r.hostname,
      health: r.health,
      lastHeartbeatAt: r.lastHeartbeatAt,
      agentVersion: r.agentVersion,
      stagedVersion: r.stagedVersion,
      preflightOverall: pf?.overall ?? null,
      problems,
    };
  });
}

export const MAX_IMPORT_ROWS = 200;

/**
 * Bulk import: one person per line, "Name, email" (a header line and blank lines are
 * ignored). Each valid line is added like a single employee (invite email if
 * configured); problems are reported per line and never stop the rest.
 */
export async function importEmployees(
  deps: AdminDeps,
  s: SessionState | null,
  firmId: string,
  input: unknown,
) {
  requireFirmAccess(s, firmId);
  const text = (input as { text?: unknown } | null)?.text;
  if (typeof text !== "string" || text.length > 50_000) throw new InputError("Paste the list as text.");
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const rows = lines
    .map((l, i) => ({ line: i + 1, raw: l }))
    .filter((r) => r.raw !== "" && !/^name\s*[,;\t]\s*e-?mail/i.test(r.raw));
  if (rows.length === 0) throw new InputError("The list is empty.");
  if (rows.length > MAX_IMPORT_ROWS) throw new InputError(`At most ${MAX_IMPORT_ROWS} people at a time.`);
  const added: { line: number; name: string; inviteSent: boolean }[] = [];
  const skipped: { line: number; reason: string }[] = [];
  for (const r of rows) {
    const parts = r.raw.split(/[,;\t]/).map((p) => p.trim());
    const [name, email] = [parts[0] ?? "", parts[1] ?? ""];
    if (parts.length < 2 || !name || !email) {
      skipped.push({ line: r.line, reason: "Write it as: Name, email" });
      continue;
    }
    try {
      const res = await addEmployee(deps, s, firmId, { name, email });
      added.push({ line: r.line, name, inviteSent: res.inviteSent });
    } catch (e) {
      skipped.push({
        line: r.line,
        reason: e instanceof InputError ? e.message : "Couldn't add this person.",
      });
    }
  }
  return { added, skipped };
}
