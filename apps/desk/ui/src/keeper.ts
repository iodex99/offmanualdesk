// Keeps the employee's gateway in the right state (ARCHITECTURE F4 step 5):
// stops it after the firm's idle hours (saves memory on a shared RDS host), starts it
// again on the next message or review action, and restarts it after a crash (at most
// MAX_RESTARTS an hour, then the employee sees a plain message with Try again).
import type { GatewayApi } from "./gatewayApi";

export interface GatewayStatus {
  running: boolean;
  port: number | null;
}

export interface GatewayControl {
  start(): Promise<GatewayStatus>;
  stop(): Promise<void>;
  status(): Promise<GatewayStatus>;
}

export type KeeperState = "running" | "resting" | "starting" | "crashed";

export const MAX_RESTARTS = 3;
export const DEFAULT_IDLE_STOP_HOURS = 4;
const HOUR = 3_600_000;

export class GatewayKeeper {
  private state: KeeperState = "running";
  private last: number;
  private restarts: number[] = [];
  private starting: Promise<void> | null = null;

  constructor(
    private readonly ctrl: GatewayControl,
    private idleStopMs: number,
    private readonly now: () => number,
    private readonly onChange: (s: KeeperState) => void = () => undefined,
  ) {
    this.last = now();
  }

  get current(): KeeperState {
    return this.state;
  }

  setIdleStopHours(hours: number) {
    if (Number.isFinite(hours) && hours >= 1 && hours <= 24) this.idleStopMs = hours * HOUR;
  }

  private set(s: KeeperState) {
    if (s !== this.state) {
      this.state = s;
      this.onChange(s);
    }
  }

  /** Employee activity (a message, a review decision). */
  touch() {
    this.last = this.now();
  }

  /** Before using the gateway: start it if it was resting or crashed. */
  async ensureRunning(): Promise<void> {
    this.touch();
    if (this.state === "running") return;
    if (!this.starting) {
      this.set("starting");
      this.starting = this.ctrl
        .start()
        .then((s) => {
          if (!s.running) throw { message: "Your assistant couldn't start. Try again." };
          this.set("running");
        })
        .catch((e: unknown) => {
          this.set("crashed");
          throw e;
        })
        .finally(() => {
          this.starting = null;
        });
    }
    return this.starting;
  }

  /** Periodic check (every 30 s): idle stop, crash restart. */
  async tick(): Promise<void> {
    if (this.state !== "running") return;
    const now = this.now();
    if (now - this.last >= this.idleStopMs) {
      await this.ctrl.stop().catch(() => undefined);
      this.set("resting");
      return;
    }
    const s = await this.ctrl.status().catch(() => null);
    if (s === null || s.running) return; // can't tell, or fine
    this.restarts = this.restarts.filter((t) => now - t < HOUR);
    if (this.restarts.length >= MAX_RESTARTS) {
      this.set("crashed");
      return;
    }
    this.restarts.push(now);
    this.set("crashed"); // until the restart below succeeds
    await this.ensureRunning().catch(() => undefined);
  }
}

/** Wraps the gateway API so every use first makes sure the gateway runs. */
export function keptGateway(api: GatewayApi, keeper: GatewayKeeper): GatewayApi {
  return {
    async send(message) {
      await keeper.ensureRunning();
      return api.send(message);
    },
    abort: (runId) => api.abort(runId),
    onChat: (cb) => api.onChat(cb),
    async reviewList() {
      await keeper.ensureRunning();
      return api.reviewList();
    },
    async reviewDecide(ids, decision, params, grant) {
      await keeper.ensureRunning();
      return api.reviewDecide(ids, decision, params, grant);
    },
  };
}
