// Update notice (UPDATES.md §4, ADR-048): "Off Manual <v> is ready. Restart to update."
// Security releases install themselves once their deadline has passed.
import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { formatDate } from "@offmanual/shared-schema/format";
import { callAgent } from "./agent";
import { messageOf } from "./gatewayApi";

export interface UpdateStatus {
  running: string | null;
  available: string | null;
  severity: string;
  deadlineAt: string | null;
}

export interface UpdateApi {
  check(): Promise<UpdateStatus>;
  apply(version: string): Promise<unknown>;
  /** Tells the Server Agent which release this person's assistant runs (ADR-063). */
  report?(version: string): Promise<unknown>;
}

export const tauriUpdates: UpdateApi = {
  async check() {
    if (!isTauri()) return { running: null, available: null, severity: "", deadlineAt: null };
    return invoke<UpdateStatus>("update_status");
  },
  async apply(version) {
    return invoke("update_apply", { version });
  },
  async report(version) {
    return callAgent("update.report", { version });
  },
};

type State =
  | { kind: "idle" }
  | { kind: "available"; s: UpdateStatus & { available: string } }
  | { kind: "updating"; version: string; automatic: boolean }
  | { kind: "done"; version: string }
  | { kind: "failed"; message: string };

// Stable defaults: a new function per render would re-run the check effect every render.
const realNow = () => new Date();

export function UpdateNotice({ api = tauriUpdates, now = realNow }: { api?: UpdateApi; now?: () => Date }) {
  const [state, setState] = useState<State>({ kind: "idle" });

  const apply = useCallback(
    async (version: string, automatic: boolean) => {
      setState({ kind: "updating", version, automatic });
      try {
        await api.apply(version);
        setState({ kind: "done", version });
        void api.report?.(version).catch(() => undefined);
      } catch (e) {
        setState({ kind: "failed", message: messageOf(e, "The update didn't work. Try again later.") });
      }
    },
    [api],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .check()
      .then((s) => {
        if (s.running) void api.report?.(s.running).catch(() => undefined); // best effort
        if (cancelled || !s.available) return;
        const due =
          s.severity === "security" && s.deadlineAt !== null && Date.parse(s.deadlineAt) <= now().getTime();
        if (due) void apply(s.available, true);
        else setState({ kind: "available", s: { ...s, available: s.available } });
      })
      .catch(() => undefined); // no notice when the Server Agent can't be asked
    return () => {
      cancelled = true;
    };
  }, [api, apply, now]);

  switch (state.kind) {
    case "idle":
      return null;
    case "available": {
      const { available, severity, deadlineAt } = state.s;
      return (
        <div className="notice" role="status">
          <p>
            {severity === "security"
              ? `Security update ${available} is ready.`
              : `Off Manual ${available} is ready.`}{" "}
            {severity === "security" && deadlineAt
              ? `It installs itself after ${formatDate(new Date(deadlineAt))}. `
              : ""}
            Your assistant restarts for a few seconds.
          </p>
          <button onClick={() => void apply(available, false)}>Restart to update</button>
        </div>
      );
    }
    case "updating":
      return (
        <p className="notice" role="status">
          {state.automatic ? "Installing a security update" : `Updating to ${state.version}`}… your assistant
          restarts.
        </p>
      );
    case "done":
      return (
        <p className="notice" role="status">
          Updated to {state.version}.
        </p>
      );
    case "failed":
      return (
        <p className="notice" role="alert">
          {state.message}
        </p>
      );
  }
}
