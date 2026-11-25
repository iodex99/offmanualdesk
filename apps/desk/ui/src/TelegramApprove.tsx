// "Approve on Telegram" on the PIN screen (ADR-068, option b): in place of the PIN only,
// after today's authenticator code. The Server Agent decides whether it's offered and
// checks every rule again when the button on the phone is tapped.
import { useEffect, useRef, useState } from "react";
import { isAgentError, type AgentCall } from "./agent";

export const POLL_MS = 2_000;
export const GIVE_UP_MS = 70_000; // the request itself lasts 60 s

type State = { kind: "idle" } | { kind: "waiting"; id: string } | { kind: "error"; text: string };

export function TelegramApprove({
  agent,
  onApproved,
  now = Date.now,
}: {
  agent: AgentCall;
  onApproved: () => void;
  now?: () => number;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const started = useRef(0);

  useEffect(() => {
    if (state.kind !== "waiting") return;
    let live = true;
    const id = window.setInterval(() => {
      void (async () => {
        if (now() - started.current > GIVE_UP_MS) {
          if (live) setState({ kind: "error", text: "No answer from Telegram. Try again or use your PIN." });
          return;
        }
        try {
          const r = (await agent("unlock.telegramStatus", { requestId: state.id })) as { status?: string };
          if (!live) return;
          if (r.status === "approved") onApproved();
          else if (r.status === "denied")
            setState({ kind: "error", text: "Denied on Telegram. Desk stays locked." });
          else if (r.status === "expired")
            setState({ kind: "error", text: "The request expired. Try again or use your PIN." });
        } catch {
          // The Server Agent may be restarting; keep waiting until the request runs out.
        }
      })();
    }, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [state, agent, onApproved, now]);

  const start = async () => {
    try {
      const r = (await agent("unlock.telegramStart", {})) as { requestId: string };
      started.current = now();
      setState({ kind: "waiting", id: r.requestId });
    } catch (e) {
      setState({
        kind: "error",
        text: isAgentError(e) ? e.message : "Telegram isn't available right now. Unlock with your PIN.",
      });
    }
  };

  if (state.kind === "waiting") {
    return <p role="status">Check Telegram on your phone and tap Approve.</p>;
  }
  return (
    <>
      <button type="button" onClick={() => void start()}>
        Approve on Telegram
      </button>
      {state.kind === "error" && <p role="alert">{state.text}</p>}
    </>
  );
}
