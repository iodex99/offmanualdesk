// Report a problem (ARCHITECTURE F11, ADR-050). The employee sees exactly what is
// sent: versions, settings state, the server check and the Server Agent's own log
// lines (no files, no chats). Their description is the only free text.
import { useState } from "react";
import type { AgentCall } from "./agent";
import { loadAppInfo } from "./appInfo";
import { messageOf } from "./gatewayApi";

export const MAX_DESCRIPTION = 500;

type State =
  | { kind: "writing" }
  | { kind: "preview"; bundle: unknown }
  | { kind: "sent"; ticket: string }
  | { kind: "loading" };

export function ReportProblem({
  agent,
  deskInfo = async () => ({ deskVersion: (await loadAppInfo()).version }),
}: {
  agent: AgentCall;
  deskInfo?: () => Promise<Record<string, string | boolean | number | null>>;
}) {
  const [state, setState] = useState<State>({ kind: "writing" });
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  const desk = async () => deskInfo().catch(() => ({}));

  const preview = async () => {
    setError("");
    setState({ kind: "loading" });
    try {
      setState({ kind: "preview", bundle: await agent("support.bundle", { desk: await desk() }) });
    } catch (e) {
      setState({ kind: "writing" });
      setError(messageOf(e, "Couldn't collect the details. Try again."));
    }
  };

  const send = async () => {
    setError("");
    setState({ kind: "loading" });
    try {
      const r = (await agent("support.submit", { description: text.trim(), desk: await desk() })) as {
        ticket?: unknown;
      };
      setState({ kind: "sent", ticket: typeof r.ticket === "string" ? r.ticket : "" });
    } catch (e) {
      setState({ kind: "writing" });
      setError(messageOf(e, "Couldn't send your report. Try again."));
    }
  };

  if (state.kind === "sent") {
    return (
      <section aria-label="Report a problem">
        <p role="status">
          Thanks. Your report {state.ticket ? <strong>{state.ticket}</strong> : null} reached Off Manual.
          Quote it if you call us.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Report a problem">
      <p>Tell us what went wrong in a few words.</p>
      <p className="hint">
        Don&apos;t include client names, PAN, amounts or file contents. We don&apos;t need them.
      </p>
      <label>
        What happened?
        <textarea
          rows={4}
          maxLength={MAX_DESCRIPTION}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <p className="hint">
        {text.length}/{MAX_DESCRIPTION}
      </p>
      {state.kind === "preview" && (
        <details open>
          <summary>What will be sent with it</summary>
          <pre className="bundle">{JSON.stringify(state.bundle, null, 2)}</pre>
        </details>
      )}
      <button disabled={state.kind === "loading"} onClick={() => void preview()}>
        Show what is sent
      </button>{" "}
      <button disabled={state.kind === "loading" || !text.trim()} onClick={() => void send()}>
        Send report
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
