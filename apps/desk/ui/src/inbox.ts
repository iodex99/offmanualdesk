// "Ask Off Manual" from Explorer (ADR-059): a second Desk launch hands the path to this
// one; Rust queues it and signals `om-inbox`, the UI takes the queue.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type InboxRequest = { kind: "show" } | { kind: "ask"; path: string };

export interface InboxApi {
  take(): Promise<InboxRequest[]>;
  onSignal(cb: () => void): Promise<() => void>;
}

export const tauriInbox: InboxApi = {
  take: () => (isTauri() ? invoke<InboxRequest[]>("inbox_take") : Promise.resolve([])),
  onSignal: (cb) => (isTauri() ? listen("om-inbox", () => cb()) : Promise.resolve(() => undefined)),
};

/** What goes in the chat box for a path (the employee finishes the question). */
export const askPrompt = (path: string) => `About ${path}: `;

/** The newest "ask" in a batch, if any. */
export function latestAsk(reqs: InboxRequest[]): string | null {
  for (let i = reqs.length - 1; i >= 0; i--) {
    const r = reqs[i]!;
    if (r.kind === "ask" && typeof r.path === "string" && r.path.length > 0) return r.path;
  }
  return null;
}
