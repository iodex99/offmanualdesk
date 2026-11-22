// Chat and Review calls to the employee's own gateway, through Rust (ADR-021). The
// token stays in Rust; the UI gets trimmed chat events and plain error messages.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface ChatEvent {
  runId: string;
  state: "status" | "delta" | "final" | "aborted" | "error";
  deltaText: string;
  replace: boolean;
  errorMessage: string;
}

export type ReviewStatus = "pending" | "approved" | "rejected" | "done" | "failed";

export interface ReviewItem {
  id: string;
  kind: string;
  params: unknown;
  summary: string;
  status: ReviewStatus;
  createdAt: string;
  result?: string;
}

export interface DecisionResult {
  id: string;
  status: ReviewStatus | "not_found";
  message: string;
}

export interface GatewayApi {
  send(message: string): Promise<string>;
  abort(runId?: string): Promise<void>;
  /** Subscribes to chat events; resolves to an unsubscribe function. */
  onChat(cb: (e: ChatEvent) => void): Promise<() => void>;
  reviewList(): Promise<ReviewItem[]>;
  reviewDecide(ids: string[], decision: "approve" | "reject", params?: unknown): Promise<DecisionResult[]>;
}

const preview = { message: "Preview mode: your assistant only runs inside Off Manual Desk." };

export const tauriGateway: GatewayApi = {
  async send(message) {
    if (!isTauri()) throw preview;
    return invoke<string>("chat_send", { message });
  },
  async abort(runId) {
    if (!isTauri()) return;
    await invoke("chat_abort", { runId: runId ?? null });
  },
  async onChat(cb) {
    if (!isTauri()) return () => undefined;
    return listen<ChatEvent>("om-chat", (e) => cb(e.payload));
  },
  async reviewList() {
    if (!isTauri()) throw preview;
    const r = await invoke<{ items?: ReviewItem[] }>("review_list");
    return Array.isArray(r.items) ? r.items : [];
  },
  async reviewDecide(ids, decision, params) {
    if (!isTauri()) throw preview;
    const r = await invoke<{ results?: DecisionResult[] }>("review_decide", {
      ids,
      decision,
      params: params ?? null,
    });
    return Array.isArray(r.results) ? r.results : [];
  },
};

/** The plain message from a Rust error, or a fallback. */
export function messageOf(e: unknown, fallback: string): string {
  return typeof e === "object" && e !== null && "message" in e && String((e as { message: unknown }).message)
    ? String((e as { message: unknown }).message)
    : fallback;
}
