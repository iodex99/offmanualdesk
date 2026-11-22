// Settings tab (ADR-066): which side Desk docks to and a shorter lock time than the
// firm's maximum. The firm's rule always wins.
import { useEffect, useState } from "react";
import type { AgentCall } from "./agent";
import { timeoutFrom } from "./idleLock";
import {
  DEFAULT_SETTINGS,
  lockChoices,
  tauriSettings,
  type DeskSettings,
  type SettingsApi,
} from "./settings";

export function SettingsTab({ agent, api = tauriSettings }: { agent: AgentCall; api?: SettingsApi }) {
  const [s, setS] = useState<DeskSettings | null>(null);
  const [firmMax, setFirmMax] = useState(15);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .get()
      .then((v) => live && setS(v))
      .catch(() => live && setS(DEFAULT_SETTINGS));
    agent("policy.get")
      .then((p) => live && setFirmMax(timeoutFrom(p)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, agent]);

  if (!s) return <p className="hint">Loading…</p>;
  const save = async (next: DeskSettings) => {
    setS(next);
    setNote(null);
    try {
      await api.set(next);
      setNote({ ok: true, text: "Saved." });
    } catch (e) {
      const m = typeof e === "string" ? e : "Your settings couldn't be saved. Try again.";
      setNote({ ok: false, text: m });
    }
  };
  const current = s.lockMinutes !== null && s.lockMinutes < firmMax ? s.lockMinutes : firmMax;
  return (
    <section aria-label="Settings">
      <fieldset>
        <legend>Dock Off Manual on the</legend>
        {(["right", "left"] as const).map((side) => (
          <label key={side}>
            <input
              type="radio"
              name="side"
              checked={s.side === side}
              onChange={() => void save({ ...s, side })}
            />{" "}
            {side === "right" ? "Right" : "Left"} side
          </label>
        ))}
      </fieldset>
      <label>
        Lock after{" "}
        <select
          aria-label="Lock after"
          value={current}
          onChange={(e) => {
            const m = Number(e.currentTarget.value);
            void save({ ...s, lockMinutes: m >= firmMax ? null : m });
          }}
        >
          {lockChoices(firmMax).map((m) => (
            <option key={m} value={m}>
              {m} minutes{m === firmMax ? " (your firm's limit)" : ""}
            </option>
          ))}
        </select>{" "}
        without using the computer.
      </label>
      <p className="hint">Press Ctrl+Alt+O to bring Off Manual forward from any app.</p>
      {note && <p role={note.ok ? "status" : "alert"}>{note.text}</p>}
    </section>
  );
}
