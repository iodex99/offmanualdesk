// Link Telegram (ARCHITECTURE F7 step 1): a one-time link from the Server Agent, shown
// as a QR code because Telegram is on the employee's phone, not on the RDS server.
import { useState } from "react";
import QRCode from "qrcode";
import type { AgentCall } from "./agent";
import { messageOf } from "./gatewayApi";

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; url: string; qr: string; minutes: string }
  | { kind: "failed"; message: string };

export function TelegramLink({ agent }: { agent: AgentCall }) {
  const [state, setState] = useState<State>({ kind: "idle" });

  const start = async () => {
    setState({ kind: "loading" });
    try {
      const r = (await agent("telegram.linkStart")) as { url?: unknown; expiresInMinutes?: unknown };
      const url = typeof r.url === "string" ? r.url : "";
      if (!url.startsWith("https://t.me/")) throw { message: "Unexpected reply from the server." };
      setState({
        kind: "ready",
        url,
        qr: await QRCode.toDataURL(url),
        minutes: typeof r.expiresInMinutes === "string" ? r.expiresInMinutes : "10",
      });
    } catch (e) {
      setState({ kind: "failed", message: messageOf(e, "Couldn't create a link. Try again.") });
    }
  };

  return (
    <section aria-label="Telegram">
      <p>Use Off Manual from your phone: link your Telegram account once, then message the firm's bot.</p>
      {state.kind === "ready" ? (
        <>
          <p>Scan this with your phone's camera, open it in Telegram and press Start.</p>
          <img src={state.qr} alt="QR code for the Telegram link" width={200} height={200} />
          <p className="hint">
            Or open <code>{state.url}</code> on your phone. The link works once and expires in {state.minutes}{" "}
            minutes.
          </p>
          <button onClick={() => void start()}>New link</button>
        </>
      ) : (
        <>
          {state.kind === "failed" && <p role="alert">{state.message}</p>}
          <button disabled={state.kind === "loading"} onClick={() => void start()}>
            {state.kind === "loading" ? "Creating link…" : "Link Telegram"}
          </button>
        </>
      )}
    </section>
  );
}
