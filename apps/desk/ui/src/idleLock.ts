// Idle lock (ARCHITECTURE F3): after the firm's lock timeout without keyboard or
// mouse input in this Windows session, Desk locks (lock.set) and the guard then
// refuses turns from every channel.
import { useEffect, useRef } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AgentCall } from "./agent";

export const POLL_MS = 30_000;
export const DEFAULT_TIMEOUT_MIN = 15;

/** Session idle seconds from Rust (GetLastInputInfo); null when unavailable. */
export type ReadIdle = () => Promise<number | null>;

export const readSessionIdle: ReadIdle = async () => {
  if (!isTauri()) return null;
  const v = await invoke<number | null>("idle_seconds");
  return typeof v === "number" ? v : null;
};

/** Lock timeout in minutes from policy.get (firm maximum), defaulting to 15. */
export function timeoutFrom(policy: unknown): number {
  const v = (policy as { lockTimeoutMax?: unknown } | null)?.lockTimeoutMax;
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 480
    ? Math.floor(v)
    : DEFAULT_TIMEOUT_MIN;
}

/**
 * While `active`, checks idle time every POLL_MS and locks once the timeout passes.
 * If the session idle time can't be read, falls back to activity inside Desk's window.
 */
export function useIdleLock(opts: {
  active: boolean;
  agent: AgentCall;
  onLocked: () => void;
  readIdle?: ReadIdle;
  now?: () => number;
}) {
  const { active, agent, onLocked, readIdle = readSessionIdle, now = Date.now } = opts;
  const lastActivity = useRef(now());
  const timeoutMin = useRef(DEFAULT_TIMEOUT_MIN);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let locking = false;
    lastActivity.current = now();
    const touch = () => {
      lastActivity.current = now();
    };
    for (const ev of ["mousemove", "keydown", "mousedown", "wheel"] as const)
      window.addEventListener(ev, touch);
    agent("policy.get")
      .then((p) => {
        timeoutMin.current = timeoutFrom(p);
      })
      .catch(() => undefined); // keep the default

    const check = async () => {
      if (cancelled || locking) return;
      let idleSec = await readIdle().catch(() => null);
      if (idleSec === null) idleSec = Math.floor((now() - lastActivity.current) / 1000);
      if (idleSec >= timeoutMin.current * 60) {
        locking = true;
        try {
          await agent("lock.set", { locked: true });
        } catch {
          // The agent may be restarting; try again on the next tick.
          locking = false;
          return;
        }
        if (!cancelled) onLocked();
      }
    };
    const id = window.setInterval(() => void check(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      for (const ev of ["mousemove", "keydown", "mousedown", "wheel"] as const)
        window.removeEventListener(ev, touch);
    };
  }, [active, agent, onLocked, readIdle, now]);
}
