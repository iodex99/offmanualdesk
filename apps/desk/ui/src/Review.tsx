// Review tab (ARCHITECTURE F6, ADR-041): proposed irreversible actions wait here until
// the employee approves, edits or rejects them. Nothing runs without a click here.
import { useCallback, useEffect, useState } from "react";
import { formatDate } from "@offmanual/shared-schema/format";
import { messageOf, type DecisionResult, type GatewayApi, type ReviewItem } from "./gatewayApi";

interface DeleteParams {
  paths: string[];
  reason: string;
}

function deleteParams(p: unknown): DeleteParams | null {
  const o = p as Partial<DeleteParams> | null;
  return o && Array.isArray(o.paths) && typeof o.reason === "string"
    ? { paths: o.paths, reason: o.reason }
    : null;
}

const STATUS: Record<string, string> = {
  done: "Done",
  failed: "Not done",
  rejected: "Rejected",
  approved: "Running",
  pending: "Waiting",
};

export function Review({ api }: { api: GatewayApi }) {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<DecisionResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; keep: Set<string> } | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api.reviewList());
      setError("");
    } catch (e) {
      setError(messageOf(e, "The review list couldn't be loaded. Try again."));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (ids: string[], decision: "approve" | "reject", params?: unknown) => {
    setBusy(true);
    try {
      setNotes(await api.reviewDecide(ids, decision, params));
      setEditing(null);
    } catch (e) {
      setNotes([]);
      setError(messageOf(e, "That didn't go through. Try again."));
    } finally {
      setBusy(false);
      await load();
    }
  };

  if (items === null)
    return error ? <ErrorBox message={error} retry={load} /> : <p className="hint">Loading…</p>;

  const pending = items.filter((p) => p.status === "pending");
  const history = items
    .filter((p) => p.status !== "pending")
    .slice(-10)
    .reverse();

  return (
    <section aria-label="Review">
      {error && <ErrorBox message={error} retry={load} />}
      {notes.length > 0 && (
        <ul className="review__notes" aria-live="polite">
          {notes.map((n) => (
            <li key={n.id}>
              #{n.id}: {n.message}
            </li>
          ))}
        </ul>
      )}
      {pending.length === 0 ? (
        <p>Nothing is waiting for your approval.</p>
      ) : (
        <>
          <p>
            {pending.length === 1 ? "1 item is" : `${pending.length} items are`} waiting for your approval.
            Nothing happens until you approve.
          </p>
          {pending.length > 1 && (
            <button
              disabled={busy}
              onClick={() =>
                void decide(
                  pending.map((p) => p.id),
                  "approve",
                )
              }
            >
              Approve all
            </button>
          )}
          <ul className="review__list">
            {pending.map((p) => {
              const del = p.kind === "delete_files" ? deleteParams(p.params) : null;
              const isEditing = editing?.id === p.id && del;
              return (
                <li key={p.id} className="review__item">
                  <p>
                    <strong>#{p.id}</strong> {p.summary}
                  </p>
                  <p className="hint">Asked on {formatDate(new Date(p.createdAt))}</p>
                  {isEditing && editing ? (
                    <fieldset>
                      <legend>Untick any file that should stay</legend>
                      {del.paths.map((path) => (
                        <label key={path} className="review__path">
                          <input
                            type="checkbox"
                            checked={editing.keep.has(path)}
                            onChange={() => {
                              const keep = new Set(editing.keep);
                              if (keep.has(path)) keep.delete(path);
                              else keep.add(path);
                              setEditing({ id: p.id, keep });
                            }}
                          />
                          {path}
                        </label>
                      ))}
                      <button
                        disabled={busy || editing.keep.size === 0}
                        onClick={() =>
                          void decide([p.id], "approve", {
                            paths: del.paths.filter((x) => editing.keep.has(x)),
                            reason: del.reason,
                          })
                        }
                      >
                        Approve ticked files
                      </button>
                      <button disabled={busy} onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </fieldset>
                  ) : (
                    <div className="review__actions">
                      <button disabled={busy} onClick={() => void decide([p.id], "approve")}>
                        Approve
                      </button>
                      {del && (
                        <button
                          disabled={busy}
                          onClick={() => setEditing({ id: p.id, keep: new Set(del.paths) })}
                        >
                          Edit
                        </button>
                      )}
                      <button disabled={busy} onClick={() => void decide([p.id], "reject")}>
                        Reject
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {history.length > 0 && (
        <details>
          <summary>Recent decisions</summary>
          <ul>
            {history.map((p) => (
              <li key={p.id}>
                #{p.id} {STATUS[p.status] ?? p.status}: {p.summary}
                {p.result ? ` ${p.result}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
      <button onClick={() => void load()}>Refresh</button>
    </section>
  );
}

function ErrorBox({ message, retry }: { message: string; retry: () => Promise<void> }) {
  return (
    <div role="alert">
      <p>{message}</p>
      <button onClick={() => void retry()}>Try again</button>
    </div>
  );
}
