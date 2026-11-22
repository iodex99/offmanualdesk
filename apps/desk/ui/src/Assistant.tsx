// Starts the employee's assistant (gateway) after unlock and shows its status
// (ARCHITECTURE F4). The token never reaches the UI; Rust keeps it.
import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

export interface GatewayStatus {
  running: boolean;
  port: number | null;
}

export type StartGateway = () => Promise<GatewayStatus>;

export const startGateway: StartGateway = async () => {
  if (!isTauri()) throw { message: "Preview mode: the assistant only runs inside Off Manual Desk." };
  return invoke<GatewayStatus>("gateway_start");
};

type State = { kind: "starting" } | { kind: "ready" } | { kind: "failed"; message: string };

export function Assistant({ start = startGateway }: { start?: StartGateway }) {
  const [state, setState] = useState<State>({ kind: "starting" });

  const run = useCallback(async () => {
    setState({ kind: "starting" });
    try {
      const s = await start();
      setState(
        s.running ? { kind: "ready" } : { kind: "failed", message: "Your assistant stopped. Try again." },
      );
    } catch (e) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message: unknown }).message)
          : "";
      setState({ kind: "failed", message: message || "Your assistant couldn't start. Try again." });
    }
  }, [start]);

  useEffect(() => {
    void run();
  }, [run]);

  switch (state.kind) {
    case "starting":
      return <p className="hint">Starting your assistant… this takes a few seconds.</p>;
    case "ready":
      return <p>Your assistant is ready.</p>;
    case "failed":
      return (
        <div role="alert">
          <p>{state.message}</p>
          <button onClick={() => void run()}>Try again</button>
        </div>
      );
  }
}
