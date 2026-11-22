// Talks to the Server Agent through `server-agent.exe bridge` (ADR-034): Node can't
// open the pipe with the exact access rights, so the bridge does, after checking the
// server is LocalSystem. NDJSON JSON-RPC over the child's stdin/stdout.
//
// Fail closed (.claude/rules/openclaw.md): any error, timeout or dead bridge rejects,
// and callers treat a rejection as "locked".
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/** Methods the guard may call. */
export const GUARD_METHODS = ["lock.get", "policy.get", "audit.append", "auth.stepUpCheck"] as const;
export type GuardMethod = (typeof GUARD_METHODS)[number];

export class AgentUnavailable extends Error {}

export interface AgentRpcError {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout };

export class AgentBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(
    private readonly command: string,
    private readonly args: string[] = ["bridge"],
    private readonly timeoutMs = 5000,
  ) {}

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.onLine(line));
    const failAll = () => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new AgentUnavailable("Server Agent bridge stopped"));
      }
      this.pending.clear();
      if (this.child === child) this.child = null;
    };
    child.on("exit", failAll);
    child.on("error", failAll);
    child.stderr.resume(); // bridge errors are diagnostics only; never parsed
    this.child = child;
    return child;
  }

  private onLine(line: string) {
    let msg: { id?: unknown; result?: unknown; error?: AgentRpcError };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return; // not ours; the pending call will time out (fail closed)
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(msg.error);
    else p.resolve(msg.result);
  }

  call(method: GuardMethod, params: Record<string, unknown> = {}, correlationId?: string): Promise<unknown> {
    if (!(GUARD_METHODS as readonly string[]).includes(method)) {
      return Promise.reject(new Error(`method ${method} not allowed for the guard`));
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.ensure();
    } catch (e) {
      return Promise.reject(new AgentUnavailable(String(e)));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentUnavailable(`timed out waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const req = { jsonrpc: "2.0", id, method, params, ...(correlationId ? { correlationId } : {}) };
      child.stdin.write(JSON.stringify(req) + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new AgentUnavailable(String(err)));
        }
      });
    });
  }

  close() {
    this.child?.stdin.end();
    this.child?.kill();
    this.child = null;
  }
}
