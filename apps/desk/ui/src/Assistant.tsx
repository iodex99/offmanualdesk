// Starts the employee's assistant (gateway) after unlock and shows its status
// (ARCHITECTURE F4). The token never reaches the UI; Rust keeps it.
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { callAgent, type AgentCall } from "./agent";
import { Chat, type QueuedMessage } from "./Chat";
import { tauriGateway, type GatewayApi } from "./gatewayApi";
import { ReportProblem } from "./ReportProblem";
import { TaskButtons } from "./TaskButtons";
import { Review } from "./Review";
import { TelegramLink } from "./TelegramLink";
import { UpdateNotice, type UpdateApi } from "./UpdateNotice";
import {
  DEFAULT_IDLE_STOP_HOURS,
  GatewayKeeper,
  keptGateway,
  type GatewayControl,
  type KeeperState,
} from "./keeper";

export interface GatewayStatus {
  running: boolean;
  port: number | null;
}

export type StartGateway = () => Promise<GatewayStatus>;

export const startGateway: StartGateway = async () => {
  if (!isTauri()) throw { message: "Preview mode: the assistant only runs inside Off Manual Desk." };
  return invoke<GatewayStatus>("gateway_start");
};

const stopGateway = async () => {
  if (isTauri()) await invoke("gateway_stop");
};
const gatewayStatus = async (): Promise<GatewayStatus> =>
  isTauri() ? invoke<GatewayStatus>("gateway_status") : { running: true, port: null };

export const KEEPER_TICK_MS = 30_000;

type State = { kind: "starting" } | { kind: "ready" } | { kind: "failed"; message: string };

export function Assistant({
  start = startGateway,
  api = tauriGateway,
  agent = callAgent,
  updates,
  control,
}: {
  start?: StartGateway;
  api?: GatewayApi;
  agent?: AgentCall;
  updates?: UpdateApi;
  /** stop/status for the keeper; start comes from `start`. */
  control?: Omit<GatewayControl, "start">;
}) {
  const [state, setState] = useState<State>({ kind: "starting" });
  const [keeperState, setKeeperState] = useState<KeeperState>("running");
  const [queued, setQueued] = useState<QueuedMessage | null>(null);
  // Idle stop, start-on-use and crash restart (F4 step 5).
  const keeper = useMemo(
    () =>
      new GatewayKeeper(
        { start, stop: control?.stop ?? stopGateway, status: control?.status ?? gatewayStatus },
        DEFAULT_IDLE_STOP_HOURS * 3_600_000,
        Date.now,
        setKeeperState,
      ),
    [start, control],
  );
  const kept = useMemo(() => keptGateway(api, keeper), [api, keeper]);
  const [tab, setTab] = useState<"chat" | "tasks" | "review" | "telegram" | "help">("chat");

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

  const ready = state.kind === "ready";
  useEffect(() => {
    if (!ready) return;
    agent("policy.get")
      .then((p) =>
        keeper.setIdleStopHours(Number((p as { gatewayIdleStopHours?: unknown }).gatewayIdleStopHours)),
      )
      .catch(() => undefined); // keep the default
    const id = window.setInterval(() => void keeper.tick(), KEEPER_TICK_MS);
    return () => window.clearInterval(id);
  }, [ready, keeper, agent]);

  switch (state.kind) {
    case "starting":
      return <p className="hint">Starting your assistant… this takes a few seconds.</p>;
    case "ready":
      return (
        <div className="assistant">
          <p className="hint">
            {keeperState === "resting"
              ? "Your assistant is resting to save memory. It starts again when you send a message."
              : keeperState === "starting"
                ? "Starting your assistant…"
                : keeperState === "crashed"
                  ? "Your assistant stopped. It starts again when you send a message."
                  : "Your assistant is ready."}
          </p>
          <UpdateNotice {...(updates ? { api: updates } : {})} />
          <nav className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>
              Chat
            </button>
            <button role="tab" aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}>
              Tasks
            </button>
            <button role="tab" aria-selected={tab === "review"} onClick={() => setTab("review")}>
              Review
            </button>
            <button role="tab" aria-selected={tab === "telegram"} onClick={() => setTab("telegram")}>
              Telegram
            </button>
            <button role="tab" aria-selected={tab === "help"} onClick={() => setTab("help")}>
              Report a problem
            </button>
          </nav>
          {tab === "chat" && <Chat api={kept} queued={queued} />}
          {tab === "tasks" && (
            <TaskButtons
              onRun={(text) => {
                setQueued((q) => ({ id: (q?.id ?? 0) + 1, text }));
                setTab("chat");
              }}
            />
          )}
          {tab === "review" && <Review api={kept} agent={agent} />}
          {tab === "telegram" && <TelegramLink agent={agent} />}
          {tab === "help" && <ReportProblem agent={agent} />}
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
