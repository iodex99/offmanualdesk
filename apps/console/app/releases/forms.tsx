"use client";
// Superadmin release actions (UPDATES §2, §4): each posts to /api/admin/releases, which
// checks the superadmin role and the signing rule on the server (ADR-057).
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

async function post(body: Record<string, unknown>): Promise<void> {
  const res = await fetch("/api/admin/releases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof data.error === "string" ? data.error : "That didn't work. Try again.");
  }
}

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const act = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setNote(null);
    try {
      await post(body);
      setNote({ ok: true, text: done });
      router.refresh();
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "That didn't work." });
    } finally {
      setBusy(false);
    }
  };
  const view = note && (
    <span role={note.ok ? "status" : "alert"} style={{ color: note.ok ? "#1a7f37" : "#c62828" }}>
      {" "}
      {note.text}
    </span>
  );
  return { busy, act, view };
}

const RING_NAMES = ["lab", "pilot", "all"];

export function PromoteButtons({ version, rings }: { version: string; rings: number[] }) {
  const { busy, act, view } = useAction();
  const next = [1, 2].filter((r) => !rings.includes(r));
  if (next.length === 0) return null;
  return (
    <span>
      {next.map((r) => (
        <button
          key={r}
          type="button"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                `Send ${version} to ring ${r} (${RING_NAMES[r]})? Their servers stage it within 15 minutes.`,
              )
            )
              void act({ action: "promote", version, ring: r }, `Sent to ring ${r}.`);
          }}
        >
          To ring {r} ({RING_NAMES[r]})
        </button>
      ))}
      {view}
    </span>
  );
}

export function FirmRolloutForm({
  firmId,
  ring,
  pin,
  versions,
}: {
  firmId: string;
  ring: number;
  pin: string | null;
  versions: string[];
}) {
  const { busy, act, view } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const newRing = Number(f.get("ring"));
    const newPin = String(f.get("pin") ?? "");
    void act(
      { action: "rollout", firmId, ring: newRing, pin: newPin === "" ? null : newPin },
      newPin ? `Pinned to ${newPin}.` : "Saved.",
    );
  };
  return (
    <form onSubmit={submit} style={{ display: "inline" }}>
      <select name="ring" defaultValue={String(ring)} aria-label="Ring">
        {RING_NAMES.map((n, i) => (
          <option key={n} value={i}>
            {i} ({n})
          </option>
        ))}
      </select>{" "}
      <select name="pin" defaultValue={pin ?? ""} aria-label="Version pin">
        <option value="">No pin (follow the ring)</option>
        {versions.map((v) => (
          <option key={v} value={v}>
            Pin to {v}
          </option>
        ))}
      </select>{" "}
      <button type="submit" disabled={busy}>
        Save
      </button>
      {view}
    </form>
  );
}
