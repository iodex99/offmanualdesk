import { describe, expect, it } from "vitest";
import { GatewayKeeper, keptGateway, MAX_RESTARTS, type GatewayControl, type KeeperState } from "./keeper";
import { fakeGateway } from "./testGateway";

const HOUR = 3_600_000;

function control() {
  let running = true;
  const log: string[] = [];
  let failStart = false;
  const ctrl: GatewayControl = {
    async start() {
      log.push("start");
      if (failStart) throw { message: "Your assistant didn't start in time." };
      running = true;
      return { running: true, port: 18800 };
    },
    async stop() {
      log.push("stop");
      running = false;
    },
    async status() {
      return { running, port: running ? 18800 : null };
    },
  };
  return {
    ctrl,
    log,
    crash: () => (running = false),
    setFailStart: (f: boolean) => (failStart = f),
  };
}

describe("GatewayKeeper", () => {
  it("rests after the idle hours and starts again on the next message", async () => {
    let t = 0;
    const c = control();
    const states: KeeperState[] = [];
    const k = new GatewayKeeper(
      c.ctrl,
      4 * HOUR,
      () => t,
      (s) => states.push(s),
    );
    t = 3 * HOUR;
    await k.tick();
    expect(k.current).toBe("running");
    t = 4 * HOUR;
    await k.tick();
    expect(k.current).toBe("resting");
    expect(c.log).toEqual(["stop"]);

    const g = fakeGateway();
    const api = keptGateway(g.api, k);
    await api.send("hello");
    expect(c.log).toEqual(["stop", "start"]);
    expect(k.current).toBe("running");
    expect(g.sent).toEqual(["hello"]);
    expect(states).toEqual(["resting", "starting", "running"]);
  });

  it("activity postpones the idle stop", async () => {
    let t = 0;
    const c = control();
    const k = new GatewayKeeper(c.ctrl, 4 * HOUR, () => t);
    t = 3 * HOUR;
    k.touch();
    t = 6 * HOUR;
    await k.tick();
    expect(k.current).toBe("running");
  });

  it("restarts after a crash, at most MAX_RESTARTS an hour", async () => {
    let t = 0;
    const c = control();
    const k = new GatewayKeeper(c.ctrl, 24 * HOUR, () => t);
    for (let i = 0; i < MAX_RESTARTS; i++) {
      c.crash();
      t += 60_000;
      await k.tick();
      expect(k.current).toBe("running");
    }
    c.crash();
    t += 60_000;
    await k.tick();
    expect(k.current).toBe("crashed");
    expect(c.log.filter((l) => l === "start")).toHaveLength(MAX_RESTARTS);
    // The employee can still start it by sending a message.
    await keptGateway(fakeGateway().api, k).send("hi");
    expect(k.current).toBe("running");
  });

  it("a failed start leaves it crashed and passes the plain message on", async () => {
    const c = control();
    const k = new GatewayKeeper(c.ctrl, HOUR, () => 0);
    c.crash();
    c.setFailStart(true);
    await k.tick();
    expect(k.current).toBe("crashed");
    await expect(keptGateway(fakeGateway().api, k).send("hi")).rejects.toMatchObject({
      message: "Your assistant didn't start in time.",
    });
  });

  it("concurrent uses share one start", async () => {
    let t = 0;
    const c = control();
    const k = new GatewayKeeper(c.ctrl, HOUR, () => t);
    t = HOUR;
    await k.tick();
    const api = keptGateway(fakeGateway().api, k);
    await Promise.all([api.send("a"), api.reviewList(), api.send("b")]);
    expect(c.log.filter((l) => l === "start")).toHaveLength(1);
  });

  it("idle hours come from the firm policy within bounds", async () => {
    let t = 0;
    const c = control();
    const k = new GatewayKeeper(c.ctrl, 4 * HOUR, () => t);
    k.setIdleStopHours(1);
    k.setIdleStopHours(99); // ignored
    t = HOUR;
    await k.tick();
    expect(k.current).toBe("resting");
  });
});
