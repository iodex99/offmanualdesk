// Review queue (ARCHITECTURE F6, ADR-028, ADR-041).
//
// Irreversible actions are only reachable through guard-owned proposal tools. A
// proposal tool never acts: it stores the proposal here and tells the model it is
// waiting for review. A person decides in Desk (gateway methods `offmanual.review.*`,
// which the agent cannot call: the `gateway` tool is denied). On approval the guard
// executes the stored action itself, once.
//
// No OpenClaw imports here so it unit-tests without a host.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ReviewStatus = "pending" | "approved" | "rejected" | "done" | "failed";

export interface Proposal {
  id: string;
  kind: string;
  params: unknown;
  /** One plain sentence for the Review tab (local only; never sent to the console). */
  summary: string;
  status: ReviewStatus;
  createdAt: string;
  sessionKey?: string;
  decidedAt?: string;
  finishedAt?: string;
  /** Plain result shown to the employee after execution. */
  result?: string;
}

/** An action that must wait for a person. */
export interface ActionKind<P = unknown> {
  kind: string;
  /** Validates untrusted params (from the model or an edit in Desk); returns a message on error. */
  parse(params: unknown): { ok: true; value: P } | { ok: false; message: string };
  summarize(p: P): string;
  /** Runs as the employee (the gateway's Windows account). Returns a plain result line. */
  execute(p: P): Promise<{ ok: boolean; message: string }>;
}

interface StoreFile {
  version: 1;
  nextId: number;
  items: Proposal[];
}

/** Finished proposals kept for the Review tab's history. */
export const KEEP_FINISHED = 200;

export class ReviewStore {
  private data: StoreFile | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
    private readonly keepFinished = KEEP_FINISHED,
  ) {}

  /** Serialises every read-modify-write so concurrent tool calls can't lose updates. */
  private run<T>(fn: (d: StoreFile) => Promise<T> | T): Promise<T> {
    const next = this.chain.then(async () => fn(await this.load()));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<StoreFile> {
    if (this.data) return this.data;
    let d: StoreFile;
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<StoreFile>;
      d = {
        version: 1,
        nextId: Number.isInteger(raw.nextId) && (raw.nextId as number) > 0 ? (raw.nextId as number) : 1,
        items: Array.isArray(raw.items) ? raw.items : [],
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // never silently drop a corrupt queue
      d = { version: 1, nextId: 1, items: [] };
    }
    // An approval that was executing when the gateway stopped is never re-run
    // automatically: the action may or may not have happened.
    let changed = false;
    for (const p of d.items) {
      if (p.status === "approved") {
        p.status = "failed";
        p.finishedAt = this.now().toISOString();
        p.result = "Off Manual stopped while doing this. Check whether it happened before asking again.";
        changed = true;
      }
    }
    this.data = d;
    if (changed) await this.save(d);
    return d;
  }

  private async save(d: StoreFile): Promise<void> {
    const finished = d.items.filter((p) => p.status !== "pending" && p.status !== "approved");
    if (finished.length > this.keepFinished) {
      const drop = new Set(finished.slice(0, finished.length - this.keepFinished).map((p) => p.id));
      d.items = d.items.filter((p) => !drop.has(p.id));
    }
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(d, null, 1), "utf8");
    await rename(tmp, this.file);
  }

  add(kind: string, params: unknown, summary: string, sessionKey?: string): Promise<Proposal> {
    return this.run(async (d) => {
      const p: Proposal = {
        id: String(d.nextId++),
        kind,
        params,
        summary,
        status: "pending",
        createdAt: this.now().toISOString(),
        ...(sessionKey ? { sessionKey } : {}),
      };
      d.items.push(p);
      await this.save(d);
      return { ...p };
    });
  }

  list(): Promise<Proposal[]> {
    return this.run((d) => d.items.map((p) => ({ ...p })));
  }

  /** Atomically moves a pending proposal to `to` (approved/rejected), optionally replacing params. */
  claim(
    id: string,
    to: "approved" | "rejected",
    edit?: { params: unknown; summary: string },
  ): Promise<Proposal | null> {
    return this.run(async (d) => {
      const p = d.items.find((x) => x.id === id);
      if (!p || p.status !== "pending") return null;
      p.status = to;
      p.decidedAt = this.now().toISOString();
      if (edit) {
        p.params = edit.params;
        p.summary = edit.summary;
      }
      if (to === "rejected") p.finishedAt = p.decidedAt;
      await this.save(d);
      return { ...p };
    });
  }

  finish(id: string, ok: boolean, result: string): Promise<void> {
    return this.run(async (d) => {
      const p = d.items.find((x) => x.id === id);
      if (!p || p.status !== "approved") return;
      p.status = ok ? "done" : "failed";
      p.result = result;
      p.finishedAt = this.now().toISOString();
      await this.save(d);
    });
  }
}

export interface DecisionResult {
  id: string;
  status: ReviewStatus | "not_found";
  message: string;
}

export type AuditFn = (
  category: "review_queued" | "review_approved" | "review_rejected",
  action: string,
  result: string,
) => void;

/** The queue: proposal kinds + store + decisions. */
export class ReviewQueue {
  private readonly kinds = new Map<string, ActionKind>();

  constructor(
    readonly store: ReviewStore,
    kinds: ActionKind[],
    private readonly audit: AuditFn = () => undefined,
  ) {
    for (const k of kinds) this.kinds.set(k.kind, k);
  }

  kind(name: string): ActionKind | undefined {
    return this.kinds.get(name);
  }

  /** Called by a proposal tool. Throws (a tool error the model sees) on invalid params. */
  async propose(kind: string, params: unknown, sessionKey?: string): Promise<Proposal> {
    const k = this.kinds.get(kind);
    if (!k) throw new Error(`Unknown action ${kind}.`);
    const parsed = k.parse(params);
    if (!parsed.ok) throw new Error(parsed.message);
    const p = await this.store.add(kind, parsed.value, k.summarize(parsed.value), sessionKey);
    this.audit("review_queued", kind, "ok");
    return p;
  }

  /**
   * A person's decision from Desk. `edited` replaces the params of a single proposal
   * (Edit in the Review tab) and is validated like the original.
   */
  async decide(ids: string[], decision: "approve" | "reject", edited?: unknown): Promise<DecisionResult[]> {
    const out: DecisionResult[] = [];
    for (const id of ids) {
      const current = (await this.store.list()).find((p) => p.id === id);
      const k = current && this.kinds.get(current.kind);
      if (!current || !k) {
        out.push({ id, status: "not_found", message: "This item is no longer in the review queue." });
        continue;
      }
      if (decision === "reject") {
        const p = await this.store.claim(id, "rejected");
        out.push(p ? { id, status: "rejected", message: "Rejected. Nothing was done." } : stale(id));
        if (p) this.audit("review_rejected", current.kind, "ok");
        continue;
      }
      const parsed = k.parse(edited !== undefined && ids.length === 1 ? edited : current.params);
      if (!parsed.ok) {
        out.push({ id, status: "pending", message: parsed.message });
        continue;
      }
      const edit =
        edited !== undefined && ids.length === 1
          ? { params: parsed.value, summary: k.summarize(parsed.value) }
          : undefined;
      const p = await this.store.claim(id, "approved", edit);
      if (!p) {
        out.push(stale(id));
        continue;
      }
      let r: { ok: boolean; message: string };
      try {
        r = await k.execute(parsed.value);
      } catch {
        r = { ok: false, message: "Off Manual couldn't do this. Nothing more was tried." };
      }
      await this.store.finish(id, r.ok, r.message);
      this.audit("review_approved", current.kind, r.ok ? "done" : "failed");
      out.push({ id, status: r.ok ? "done" : "failed", message: r.message });
    }
    return out;
  }
}

function stale(id: string): DecisionResult {
  return { id, status: "not_found", message: "Someone already decided this item." };
}

/** Text the model receives from a proposal tool. */
export function queuedText(p: Proposal): string {
  return (
    `Queued for review #${p.id}: ${p.summary} ` +
    "Nothing has been done yet. Tell the user it is waiting in the Review tab of Off Manual Desk for their approval."
  );
}

// ---- built-in tools that would bypass the queue (defence in depth; ADR-041) ----

export const REVIEW_BLOCK_DELETE =
  "Deleting needs a person's approval. Use the offmanual_delete_files tool to put it in the Review queue.";

const BLOCKED_TOOLS = new Set(["fs_delete", "fs_move"]);
// A delete command at the start of a command, after a separator ( ; & | newline ( ` { quote),
// or after `cmd /c` / `powershell -Command`.
const DELETE_CMD =
  /(^|[;&|\n(`{'"]\s*|\/[ck]\s+|-c(ommand)?\s+)(remove-item|ri|rm|rmdir|rd|del|erase|clear-recyclebin)(\.exe)?(\s|$)|\[(system\.)?io\.(file|directory)\]::delete|\bshutil\.rmtree\b|\bos\.(remove|unlink|rmdir)\b|\bfs\.(rm|unlink|rmdir)(sync)?\b|\bunlink(sync)?\s*\(/i;

/**
 * Returns a block reason when a built-in tool call would delete something without
 * review. A heuristic, not a boundary: the review queue's real guarantee is that
 * Off Manual's own irreversible actions only exist as proposal tools, and Windows
 * rights still decide what the employee's account can touch (rule 2).
 */
export function bypassBlockReason(toolName: string, params: unknown): string | undefined {
  const name = toolName.toLowerCase();
  if (BLOCKED_TOOLS.has(name)) return REVIEW_BLOCK_DELETE;
  const a = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  if (name === "exec" || name === "shell" || name === "process") {
    const cmd = typeof a.command === "string" ? a.command : "";
    if (DELETE_CMD.test(cmd)) return REVIEW_BLOCK_DELETE;
  }
  if (name === "apply_patch") {
    const input = typeof a.input === "string" ? a.input : typeof a.patch === "string" ? a.patch : "";
    if (/^\*\*\* Delete File:/m.test(input)) return REVIEW_BLOCK_DELETE;
  }
  return undefined;
}
