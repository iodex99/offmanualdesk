// Chat panel (PRODUCT.md: docked chat). Replies stream in as `om-chat` events.
import { useEffect, useRef, useState } from "react";
import { messageOf, type ChatEvent, type GatewayApi } from "./gatewayApi";

interface Line {
  who: "you" | "assistant";
  text: string;
  note?: string;
}

export const MSG_FAILED = "Your assistant hit a problem with that. Try again, or ask in a different way.";

export interface QueuedMessage {
  id: number;
  text: string;
}

export function Chat({
  api,
  queued,
  onRunEnd,
}: {
  api: GatewayApi;
  queued?: QueuedMessage | null;
  /** Called when a reply ends, with the time (ms) the message was sent. */
  onRunEnd?: (startedAt: number) => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const runRef = useRef<string | null>(null);
  const startedAt = useRef(0);
  const endRef = useRef(onRunEnd);
  endRef.current = onRunEnd;
  // Events can arrive before chat_send returns the run id; hold them until then.
  const early = useRef<ChatEvent[]>([]);

  const apply = (e: ChatEvent) => {
    setLines((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      const current = last && last.who === "assistant" ? last : null;
      if (e.state === "delta") {
        if (current) {
          next[next.length - 1] = { ...current, text: e.replace ? e.deltaText : current.text + e.deltaText };
        } else {
          next.push({ who: "assistant", text: e.deltaText });
        }
      } else if (e.state === "aborted") {
        if (current) next[next.length - 1] = { ...current, note: "Stopped." };
        else next.push({ who: "assistant", text: "", note: "Stopped." });
      } else if (e.state === "error") {
        next.push({ who: "assistant", text: "", note: MSG_FAILED });
      }
      return next;
    });
    if (e.state === "final" || e.state === "aborted" || e.state === "error") {
      runRef.current = null;
      setRunId(null);
      setBusy(false);
      endRef.current?.(startedAt.current);
    }
  };

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void api
      .onChat((e) => {
        if (runRef.current === null) {
          early.current.push(e);
          return;
        }
        if (e.runId === runRef.current) apply(e);
      })
      .then((u) => {
        if (cancelled) u();
        else off = u;
      });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [api]);

  const send = async (override?: string) => {
    const text = (override ?? draft).trim();
    if (!text || busy) return;
    setError("");
    setBusy(true);
    startedAt.current = Date.now();
    early.current = [];
    setLines((prev) => [...prev, { who: "you", text }]);
    if (override === undefined) setDraft("");
    try {
      const id = await api.send(text);
      runRef.current = id;
      setRunId(id);
      const held = early.current.filter((e) => e.runId === id);
      early.current = [];
      held.forEach(apply);
    } catch (e) {
      setBusy(false);
      setError(messageOf(e, "Your message couldn't be sent. Try again."));
    }
  };

  // A task button's request (Tasks tab) is sent once, as if typed.
  const sentQueued = useRef<number | null>(null);
  useEffect(() => {
    if (queued && sentQueued.current !== queued.id) {
      sentQueued.current = queued.id;
      void send(queued.text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send must run once per queued id
  }, [queued]);

  return (
    <section className="chat" aria-label="Chat">
      <ol className="chat__lines">
        {lines.map((l, i) => (
          <li key={i} className={`chat__line chat__line--${l.who}`}>
            <span className="chat__who">{l.who === "you" ? "You" : "Off Manual"}</span>
            {l.text && <p>{l.text}</p>}
            {l.note && <p className="hint">{l.note}</p>}
          </li>
        ))}
      </ol>
      {error && <p role="alert">{error}</p>}
      <form
        className="chat__form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="Message"
          value={draft}
          rows={3}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {busy ? (
          <button type="button" onClick={() => void api.abort(runId ?? undefined)}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!draft.trim()}>
            Send
          </button>
        )}
      </form>
    </section>
  );
}
