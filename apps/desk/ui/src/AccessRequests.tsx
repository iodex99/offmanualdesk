// Request access after an Access Denied (PRODUCT ease rule 6, ADR-058). The note goes to
// the firm's admins on this server only; they change folder rights in Windows.
import { useCallback, useEffect, useState } from "react";
import { isAgentError, type AgentCall } from "./agent";

export interface Denial {
  id: number;
  at: string;
  target: string;
  requested: boolean;
}

export interface AccessRequest {
  id: number;
  name: string;
  target: string;
  note: string;
  createdAt: string;
  status: "open" | "done" | "declined";
  mine: boolean;
}

export const NOTE_PREFILL = "I need this for ";
const SLACK_MS = 5_000;

const plain = (e: unknown, fallback: string) => (isAgentError(e) && e.message ? e.message : fallback);

const shortDate = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
};

/** One card per folder the assistant was refused since `since` (ms), with Request access. */
export function DenialCards({ agent, since }: { agent: AgentCall; since: number }) {
  const [list, setList] = useState<Denial[]>([]);
  useEffect(() => {
    let live = true;
    agent("access.denials")
      .then((r) => {
        const all = ((r as { denials?: Denial[] }).denials ?? []).filter(
          (d) => !d.requested && Date.parse(d.at) >= since - SLACK_MS,
        );
        if (live) setList(all);
      })
      .catch(() => undefined); // the chat already says what happened
    return () => {
      live = false;
    };
  }, [agent, since]);
  if (list.length === 0) return null;
  return (
    <div className="denials">
      {list.map((d) => (
        <DenialCard key={d.id} agent={agent} denial={d} />
      ))}
    </div>
  );
}

function DenialCard({ agent, denial }: { agent: AgentCall; denial: Denial }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(NOTE_PREFILL);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");
  const what = denial.target || "that folder";
  const send = async () => {
    setState("sending");
    setError("");
    try {
      await agent("access.request", { id: denial.id, note: note.trim() });
      setState("sent");
    } catch (e) {
      setState("idle");
      setError(plain(e, "Your request couldn't be sent. Try again."));
    }
  };
  return (
    <section className="denial" role="status">
      <p>
        You are not authorised to open <strong>{what}</strong>. Off Manual can't change folder rights; your
        admin does that in Windows.
      </p>
      {state === "sent" ? (
        <p className="hint">Sent to your admin. You'll see the answer under Access.</p>
      ) : open ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label>
            Note to your admin (no client details needed)
            <textarea value={note} maxLength={300} rows={2} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button type="submit" disabled={state === "sending" || note.trim().length === 0}>
            Send request
          </button>
        </form>
      ) : (
        <button onClick={() => setOpen(true)}>Request access</button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

const STATUS: Record<AccessRequest["status"], string> = {
  open: "Waiting",
  done: "Access given",
  declined: "Declined",
};

/** Access tab: your requests, or everyone's for a firm admin (who can close them). */
export function AccessRequests({ agent }: { agent: AgentCall }) {
  const [data, setData] = useState<{ admin: boolean; requests: AccessRequest[] } | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const r = (await agent("access.list")) as { admin?: boolean; requests?: AccessRequest[] };
      setData({ admin: r.admin === true, requests: r.requests ?? [] });
      setError("");
    } catch (e) {
      setError(plain(e, "Access requests couldn't be loaded. Try again."));
    }
  }, [agent]);
  useEffect(() => {
    void load();
  }, [load]);
  const resolve = async (id: number, outcome: "done" | "declined") => {
    try {
      await agent("access.resolve", { id, outcome });
      await load();
    } catch (e) {
      setError(plain(e, "That didn't work. Try again."));
    }
  };
  if (!data) return error ? <p role="alert">{error}</p> : <p className="hint">Loading…</p>;
  return (
    <section aria-label="Access requests">
      <p className="hint">
        {data.admin
          ? "Requests from your team. Change the folder's rights in Windows first, then mark it done."
          : "Folders you asked your admin for."}
      </p>
      {error && <p role="alert">{error}</p>}
      {data.requests.length === 0 ? (
        <p>No requests.</p>
      ) : (
        <ul className="access">
          {data.requests.map((r) => (
            <li key={r.id}>
              <p>
                {data.admin && !r.mine ? `${r.name}: ` : ""}
                <strong>{r.target || "a folder"}</strong> · {shortDate(r.createdAt)} · {STATUS[r.status]}
              </p>
              <p className="hint">{r.note}</p>
              {data.admin && r.status === "open" && (
                <p>
                  <button onClick={() => void resolve(r.id, "done")}>Done</button>{" "}
                  <button onClick={() => void resolve(r.id, "declined")}>Decline</button>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
