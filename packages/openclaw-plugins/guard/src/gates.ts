// Pure decision logic for the guard (no OpenClaw or I/O imports, so it unit-tests
// without a host). plugin.ts wires these into hooks.
import { classifyErrorText, type AccessDenied } from "./access-denied.js";

// ---- lock gate (before_agent_run) ----

export interface LockStatus {
  locked: boolean;
  dayUnlocked?: boolean;
  lockedUntil?: string;
  telegramUnlockedUntil?: string;
}

export type GateDecision = { outcome: "pass" } | { outcome: "block"; reason: string; message: string };

/**
 * Decides whether a turn may run. `status` null means the Server Agent couldn't be
 * asked: fail closed. Telegram turns may run while Desk is locked only inside a
 * Telegram unlock window (ARCHITECTURE F8).
 */
export function lockGate(status: LockStatus | null, channel: "desk" | "telegram", now: Date): GateDecision {
  if (!status) {
    return {
      outcome: "block",
      reason: "agent_unavailable",
      message: "Off Manual can't check your sign-in right now. Please try again in a minute.",
    };
  }
  if (status.lockedUntil && Date.parse(status.lockedUntil) > now.getTime()) {
    return {
      outcome: "block",
      reason: "lockout",
      message: "Off Manual is locked after too many wrong codes. Try again later or ask your admin.",
    };
  }
  if (!status.locked) return { outcome: "pass" };
  if (
    channel === "telegram" &&
    status.telegramUnlockedUntil &&
    Date.parse(status.telegramUnlockedUntil) > now.getTime()
  ) {
    return { outcome: "pass" };
  }
  return {
    outcome: "block",
    reason: "locked",
    message:
      channel === "telegram"
        ? "Off Manual is locked. Unlock it in Desk, or send /unlock with today's code."
        : "Off Manual is locked. Unlock it with your PIN or today's code.",
  };
}

/** Caches lock status for at most maxAgeMs (ARCHITECTURE F5: ≤ 5 s). */
export class LockCache {
  private value: { at: number; status: LockStatus } | null = null;
  constructor(private readonly maxAgeMs = 5000) {}
  get(now: number): LockStatus | null {
    return this.value && now - this.value.at <= this.maxAgeMs ? this.value.status : null;
  }
  set(status: LockStatus, now: number) {
    this.value = { at: now, status };
  }
  clear() {
    this.value = null;
  }
}

// ---- access denied (ADR-022) ----

export const ACCESS_DENIED_TEXT =
  "ACCESS_DENIED: Windows refused access to this file or folder for this user. Stop this task now. " +
  "Do not retry, do not copy the file, and do not try another path. Tell the user they can use Request access.";

/** Structural view of a tool result: OpenClaw's content is text or image parts. */
export interface ToolResultLike {
  content: ReadonlyArray<{ type: string; text?: unknown }>;
}

/** Returns the denial if this failed tool result is an OS access denial. */
export function deniedInResult(isError: boolean | undefined, result: ToolResultLike): AccessDenied | null {
  if (!isError) return null;
  const text = result.content
    .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .join("\n");
  return classifyErrorText(text);
}

/** The replacement result the model sees instead of the raw error. */
export function deniedResult(denial: AccessDenied): {
  content: [{ type: "text"; text: string }];
  details: { offmanual: "access_denied"; code: string };
} {
  return {
    content: [{ type: "text", text: ACCESS_DENIED_TEXT }],
    details: { offmanual: "access_denied", code: denial.code },
  };
}

/** Runs in which access was denied: every later tool call is blocked. */
export class StoppedRuns {
  private runs = new Map<string, number>();
  constructor(private readonly ttlMs = 60 * 60 * 1000) {}
  stop(runId: string, now: number) {
    this.runs.set(runId, now);
    for (const [id, at] of this.runs) if (now - at > this.ttlMs) this.runs.delete(id);
  }
  isStopped(runId: string | undefined): boolean {
    return runId !== undefined && this.runs.has(runId);
  }
  end(runId: string | undefined) {
    if (runId) this.runs.delete(runId);
  }
}

export const STOPPED_BLOCK_REASON =
  "ACCESS_DENIED earlier in this task: no more tool calls are allowed. Explain to the user what was denied and stop.";

/** Best-effort display path from tool args (shown to the employee and kept in the local audit only). */
export function targetFromArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const k of ["path", "file_path", "filePath", "file", "target", "cwd"]) {
    const v = a[k];
    if (typeof v === "string" && v.length > 0) return v.slice(0, 1024);
  }
  return "";
}
