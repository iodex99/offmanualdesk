import { useEffect, useState } from "react";
import { formatDate } from "@offmanual/shared-schema/format";
import type { AppInfo } from "./appInfo";

type State = { kind: "loading" } | { kind: "ready"; info: AppInfo } | { kind: "error" };

export function App({
  loadInfo,
  now = () => new Date(),
}: {
  loadInfo: () => Promise<AppInfo>;
  now?: () => Date;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadInfo()
      .then((info) => {
        if (!cancelled) setState({ kind: "ready", info });
      })
      .catch((err: unknown) => {
        // Plain words for the employee; details only to the developer console.
        console.error("app_info failed", err);
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [loadInfo]);

  return (
    <main className="panel">
      <header className="panel__header">
        <h1>Off Manual</h1>
        <span className="panel__date">{formatDate(now())}</span>
      </header>
      {state.kind === "loading" && <p>Starting…</p>}
      {state.kind === "error" && (
        <p role="alert">
          Off Manual could not start properly. Close it and open it again from the Start menu.
        </p>
      )}
      {state.kind === "ready" && (
        <>
          <p>Sign-in and your assistant arrive in the next update.</p>
          <p className="panel__version">
            Version {state.info.version}
            {state.info.runtime === "browser" ? " (preview)" : ""}
          </p>
        </>
      )}
    </main>
  );
}
