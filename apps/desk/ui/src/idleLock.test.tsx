import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { POLL_MS, timeoutFrom, useIdleLock, type ReadIdle } from "./idleLock";
import type { AgentCall } from "./agent";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Harness(props: {
  active: boolean;
  agent: AgentCall;
  onLocked: () => void;
  readIdle: ReadIdle;
  now: () => number;
  readOwnMinutes?: () => Promise<number | null>;
}) {
  useIdleLock(props);
  return null;
}

function agentWith(lockTimeoutMax: unknown) {
  const calls: string[] = [];
  const agent: AgentCall = async (method) => {
    calls.push(method);
    if (method === "policy.get") return { lockTimeoutMax };
    if (method === "lock.set") return { locked: true };
    throw new Error("unexpected");
  };
  return { agent, calls };
}

const tick = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS);
  });
};

describe("timeoutFrom", () => {
  it("uses the firm maximum within sane bounds", () => {
    expect(timeoutFrom({ lockTimeoutMax: 10 })).toBe(10);
    expect(timeoutFrom({ lockTimeoutMax: 0 })).toBe(15);
    expect(timeoutFrom({ lockTimeoutMax: "10" })).toBe(15);
    expect(timeoutFrom(null)).toBe(15);
    expect(timeoutFrom({ lockTimeoutMax: 9999 })).toBe(15);
  });
});

describe("useIdleLock", () => {
  it("locks once the session has been idle past the firm timeout", async () => {
    const { agent, calls } = agentWith(5);
    let idle = 0;
    const onLocked = vi.fn();
    render(<Harness active agent={agent} onLocked={onLocked} readIdle={async () => idle} now={Date.now} />);
    idle = 4 * 60;
    await tick();
    expect(onLocked).not.toHaveBeenCalled();
    idle = 5 * 60;
    await tick();
    expect(onLocked).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c === "lock.set")).toHaveLength(1);
  });

  it("falls back to activity inside the window when session idle can't be read", async () => {
    const { agent } = agentWith(1);
    let t = 0;
    const onLocked = vi.fn();
    render(<Harness active agent={agent} onLocked={onLocked} readIdle={async () => null} now={() => t} />);
    t = 50_000;
    window.dispatchEvent(new Event("keydown"));
    t = 100_000;
    await tick();
    expect(onLocked).not.toHaveBeenCalled(); // 50 s since the key press
    t = 111_000;
    await tick();
    expect(onLocked).toHaveBeenCalledTimes(1);
  });

  it("does nothing while inactive", async () => {
    const { agent, calls } = agentWith(1);
    const onLocked = vi.fn();
    render(
      <Harness
        active={false}
        agent={agent}
        onLocked={onLocked}
        readIdle={async () => 99_999}
        now={Date.now}
      />,
    );
    await tick();
    expect(onLocked).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
  it("uses the employee's own shorter lock time, never a longer one (ADR-066)", async () => {
    const { agent } = agentWith(15);
    let idle = 0;
    let own: number | null = 5;
    const onLocked = vi.fn();
    render(
      <Harness
        active
        agent={agent}
        onLocked={onLocked}
        readIdle={async () => idle}
        now={Date.now}
        readOwnMinutes={async () => own}
      />,
    );
    idle = 5 * 60;
    await tick();
    expect(onLocked).toHaveBeenCalledTimes(1);
    cleanup();
    const again = vi.fn();
    own = 60; // longer than the firm allows: the firm's 15 minutes apply
    render(
      <Harness
        active
        agent={agent}
        onLocked={again}
        readIdle={async () => idle}
        now={Date.now}
        readOwnMinutes={async () => own}
      />,
    );
    idle = 14 * 60;
    await tick();
    expect(again).not.toHaveBeenCalled();
    idle = 15 * 60;
    await tick();
    expect(again).toHaveBeenCalledTimes(1);
  });
});
