// Calls the Server Agent through the Rust `agent_call` command (pipe client with
// exact access rights and a LocalSystem server check; ADR-034).
import { invoke, isTauri } from "@tauri-apps/api/core";

export interface AgentError {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

export type AgentCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export function isAgentError(e: unknown): e is AgentError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

function correlationId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return "desk-" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const callAgent: AgentCall = async (method, params = {}) => {
  if (!isTauri()) {
    throw { code: -1, message: "Preview mode: the Server Agent is only reachable inside Off Manual Desk." };
  }
  return invoke("agent_call", { method, params, correlationId: correlationId() });
};
