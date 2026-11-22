// Usage counts for billing and seat activity (ADR-051): turns from `agent_end`,
// tokens from `llm_output` usage. Counts only; never prompt or reply text.

export interface UsageCounts {
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

const safe = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export class UsageMeter {
  private c: UsageCounts = { turns: 0, inputTokens: 0, outputTokens: 0 };

  addTurn() {
    this.c.turns += 1;
  }

  /** From an `llm_output` event's `usage` ({ input, output, ... }). */
  addUsage(usage: unknown) {
    const u = (usage ?? {}) as { input?: unknown; output?: unknown };
    this.c.inputTokens += safe(u.input);
    this.c.outputTokens += safe(u.output);
  }

  /** Takes the counts to send and resets; null when there is nothing to send. */
  take(): UsageCounts | null {
    const c = this.c;
    if (c.turns === 0 && c.inputTokens === 0 && c.outputTokens === 0) return null;
    this.c = { turns: 0, inputTokens: 0, outputTokens: 0 };
    return c;
  }

  /** Puts counts back after a failed send, so they go with the next flush. */
  putBack(c: UsageCounts) {
    this.c.turns += c.turns;
    this.c.inputTokens += c.inputTokens;
    this.c.outputTokens += c.outputTokens;
  }
}

/** Sends pending counts; on failure they stay for the next attempt. */
export async function flushUsage(
  meter: UsageMeter,
  send: (c: UsageCounts) => Promise<unknown>,
): Promise<boolean> {
  const c = meter.take();
  if (!c) return true;
  try {
    await send(c);
    return true;
  } catch {
    meter.putBack(c);
    return false;
  }
}
