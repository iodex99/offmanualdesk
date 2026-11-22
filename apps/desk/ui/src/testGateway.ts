// Scripted GatewayApi for UI tests (no Tauri, no gateway).
import type { ChatEvent, DecisionResult, GatewayApi, ReviewItem } from "./gatewayApi";

export function fakeGateway(init: { items?: ReviewItem[] } = {}) {
  let listener: ((e: ChatEvent) => void) | null = null;
  const sent: string[] = [];
  const aborted: (string | undefined)[] = [];
  const decisions: { ids: string[]; decision: string; params?: unknown }[] = [];
  let items: ReviewItem[] = init.items ?? [];
  let runSeq = 0;
  const state = {
    sendError: null as unknown,
    /** Events emitted synchronously inside send(), before it resolves. */
    eventsDuringSend: [] as Omit<ChatEvent, "runId">[],
    decide: (ids: string[], decision: "approve" | "reject"): DecisionResult[] =>
      ids.map((id) => ({
        id,
        status: decision === "approve" ? "done" : "rejected",
        message: `#${id} ${decision}d`,
      })),
    listError: null as unknown,
  };
  const api: GatewayApi = {
    async send(message) {
      if (state.sendError) throw state.sendError;
      sent.push(message);
      const runId = `run-${++runSeq}`;
      for (const e of state.eventsDuringSend) listener?.({ runId, ...e });
      return runId;
    },
    async abort(runId) {
      aborted.push(runId);
    },
    async onChat(cb) {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    async reviewList() {
      if (state.listError) throw state.listError;
      return items;
    },
    async reviewDecide(ids, decision, params) {
      decisions.push({ ids, decision, ...(params !== undefined ? { params } : {}) });
      const r = state.decide(ids, decision);
      items = items.map((p) =>
        ids.includes(p.id) ? { ...p, status: decision === "approve" ? "done" : "rejected" } : p,
      );
      return r;
    },
  };
  const emit = (e: ChatEvent) => listener?.(e);
  return { api, emit, sent, aborted, decisions, state };
}
