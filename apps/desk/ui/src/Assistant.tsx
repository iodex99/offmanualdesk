// Starts the employee's assistant (gateway) after unlock and shows its status
// (ARCHITECTURE F4). The token never reaches the UI; Rust keeps it.
import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { callAgent, type AgentCall } from "./agent";
import { Chat } from "./Chat";
import { tauriGateway, type GatewayApi } from "./gatewayApi";
import { Review } from "./Review";
import { TelegramLink } from "./TelegramLink";

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

export function Assistant({
  start = startGateway,
  api = tauriGateway,
  agent = callAgent,
}: {
  start?: StartGateway;
  api?: GatewayApi;
  agent?: AgentCall;
}) {
  const [state, setState] = useState<State>({ kind: "starting" });
  const [tab, setTab] = useState<"chat" | "review" | "telegram">("chat");

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
      return (
        <div className="assistant">
          <p className="hint">Your assistant is ready.</p>
          <nav className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>
              Chat
            </button>
            <button role="tab" aria-selected={tab === "review"} onClick={() => setTab("review")}>
              Review
            </button>
            <button role="tab" aria-selected={tab === "telegram"} onClick={() => setTab("telegram")}>
              Telegram
            </button>
          </nav>
          {tab === "chat" && <Chat api={api} />}
          {tab === "review" && <Review api={api} agent={agent} />}
          {tab === "telegram" && <TelegramLink agent={agent} />}
        </div>
      );
    case "failed":
      return (
        <div role="alert">
          <p>{state.message}</p>
          <button onClick={() => void run()}>Try again</button>
        </div>
      );
  }
}
