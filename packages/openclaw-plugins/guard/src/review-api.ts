// Gateway method `offmanual.review.decide` (ADR-041) with the firm's step-up rule
// (ARCHITECTURE F3/F6, ADR-047): when the firm lists "review.approve" in
// stepUpActions, approving needs a live step-up grant of the calling employee,
// checked with the Server Agent (auth.stepUpCheck uses the OS caller identity).
import type { DecisionResult, ReviewQueue } from "./review.js";

export const STEP_UP_ACTION = "review.approve";

export interface DecideDeps {
  /** Firm step-up actions from policy.get; null when the policy can't be read (fail closed). */
  stepUpActions(): Promise<string[] | null>;
  /** Whether a grant is live for this employee and action (Server Agent). */
  grantValid(grantId: string, action: string): Promise<boolean>;
}

export type DecideOutcome =
  | { ok: true; payload: { results: DecisionResult[] } | { stepUpRequired: true; action: string } }
  | { ok: false; error: { code: string; message: string } };

const invalid: DecideOutcome = { ok: false, error: { code: "INVALID_REQUEST", message: "invalid params" } };

export async function handleDecide(
  queue: ReviewQueue,
  params: Record<string, unknown>,
  deps: DecideDeps,
): Promise<DecideOutcome> {
  const { ids, decision, stepUpGrant } = params;
  const extra = Object.keys(params).filter((k) => !["ids", "decision", "params", "stepUpGrant"].includes(k));
  if (
    extra.length > 0 ||
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 100 ||
    !ids.every((x) => typeof x === "string" && /^\d{1,9}$/.test(x)) ||
    (decision !== "approve" && decision !== "reject") ||
    (params.params !== undefined && ids.length !== 1) ||
    (stepUpGrant !== undefined && (typeof stepUpGrant !== "string" || !/^[0-9a-f]{32}$/.test(stepUpGrant)))
  ) {
    return invalid;
  }
  if (decision === "approve") {
    const actions = await deps.stepUpActions().catch(() => null);
    if (actions === null) {
      return {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Off Manual couldn't check your firm's settings. Try again in a minute.",
        },
      };
    }
    if (actions.includes(STEP_UP_ACTION)) {
      const ok =
        typeof stepUpGrant === "string" &&
        (await deps.grantValid(stepUpGrant, STEP_UP_ACTION).catch(() => false));
      if (!ok) return { ok: true, payload: { stepUpRequired: true, action: STEP_UP_ACTION } };
    }
  }
  return { ok: true, payload: { results: await queue.decide(ids as string[], decision, params.params) } };
}

/** stepUpActions from a policy.get reply. */
export function stepUpActionsFrom(reply: unknown): string[] | null {
  const a = (reply as { stepUpActions?: unknown } | null)?.stepUpActions;
  if (a === undefined) return [];
  return Array.isArray(a) && a.every((x) => typeof x === "string") ? (a as string[]) : null;
}
