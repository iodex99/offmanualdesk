// Notices from Off Manual and the firm (ADR-052): updates, billing (for firm admins)
// and admin messages. Each stays until the employee dismisses it.
import { useCallback, useEffect, useState } from "react";
import type { AgentCall } from "./agent";

export interface Notice {
  id: string;
  kind: "update" | "billing" | "admin";
  title: string;
  body: string;
}

export const NOTICES_REFRESH_MS = 15 * 60_000;

export function Notices({ agent }: { agent: AgentCall }) {
  const [list, setList] = useState<Notice[]>([]);

  const load = useCallback(async () => {
    try {
      const r = (await agent("notices.list")) as { notices?: unknown };
      setList(Array.isArray(r.notices) ? (r.notices as Notice[]) : []);
    } catch {
      // Keep what is shown; notices are not worth an error message.
    }
  }, [agent]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), NOTICES_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  if (list.length === 0) return null;
  return (
    <ul className="notices" aria-label="Notices">
      {list.map((n) => (
        <li key={n.id} className={`notice notice--${n.kind}`}>
          <strong>{n.title}</strong> <span>{n.body}</span>{" "}
          <button
            aria-label={`Dismiss: ${n.title}`}
            onClick={() => {
              setList((l) => l.filter((x) => x.id !== n.id));
              void agent("notices.ack", { id: n.id }).catch(() => undefined);
            }}
          >
            Dismiss
          </button>
        </li>
      ))}
    </ul>
  );
}
