/**
 * The host-side policy trigger (capability track N; the interface track O implements).
 *
 * This module defines the seam and nothing of O's logic (O's engine and guard live in
 * `src/policy/`). A policy sees each action the agent proposes BEFORE the actuator forwards it,
 * and may refuse it outright (a `PolicyDenial`: `deny` with `POLICY_DENIED`, no handoff) or force
 * a handoff:
 *
 *   const decision = await guardAction(policy, broker.policyTrigger(), action);
 *   if (decision.kind === "proceed") forward(action);
 *
 * `guardAction` first waits on the pause gate (no action is forwarded while any handoff is open,
 * whoever opened it), then asks the policy. If another handoff opened while the policy was
 * evaluating, the forced pause is queued as its own handoff (the human sees the policy's note) and
 * never takes the other handoff's outcome. A forced pause resolves to:
 *   approve  -> proceed (the action is forwarded as proposed)
 *   fixed-it -> skip    (the human did it; the agent is told to look again)
 *   reject   -> deny    (the action is not forwarded)
 *   timeout / cancelled -> ended (the attempt is over; nothing is forwarded)
 * A policy that throws fails closed: the action is denied, never forwarded unguarded.
 */
import type { PauseGate, PolicyPauseRequest, PolicyTrigger } from "./broker.ts";

/** What the actuator is about to do, as a policy sees it. Host-side only; never agent-facing. */
export interface ProposedAction {
  /** The actuator tool, e.g. `act`, `uia_invoke`, `write_file`. */
  readonly tool: string;
  /** Its arguments, as the agent sent them. */
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * Track O's outright refusal: the action is not forwarded and no handoff opens. The agent sees
 * `POLICY_DENIED` only; `policyId` is for the host record, never echoed to the agent here.
 */
export interface PolicyDenial {
  readonly deny: true;
  readonly policyId: string;
}

export type PolicyVerdict = PolicyPauseRequest | PolicyDenial | null;

/**
 * Track O implements this (`src/policy/guard.ts`). Return a pause request to force a handoff, a
 * denial to refuse the action, or null to let it pass.
 */
export interface HandoffPolicy {
  readonly id: string;
  evaluate(action: ProposedAction): PolicyVerdict | Promise<PolicyVerdict>;
}

function isDenial(v: PolicyPauseRequest | PolicyDenial): v is PolicyDenial {
  return (v as PolicyDenial).deny === true;
}

export type ActionDecision =
  | { readonly kind: "proceed"; readonly handoffId: string | null }
  | { readonly kind: "skip"; readonly handoffId: string }
  | { readonly kind: "deny"; readonly handoffId: string | null; readonly code: string }
  | {
      readonly kind: "ended";
      readonly code: "HANDOFF_TIMEOUT" | "HANDOFF_CANCELLED" | "ATTEMPT_ENDED";
    };

export async function guardAction(
  policy: HandoffPolicy,
  trigger: PolicyTrigger & PauseGate,
  action: ProposedAction,
): Promise<ActionDecision> {
  const gate = await trigger.awaitClear();
  if (gate === "ended") return { kind: "ended", code: "ATTEMPT_ENDED" };
  let verdict: PolicyVerdict;
  try {
    verdict = await policy.evaluate(action);
  } catch {
    return { kind: "deny", handoffId: null, code: "POLICY_ERROR" };
  }
  if (verdict === null) return { kind: "proceed", handoffId: null };
  if (typeof verdict !== "object") return { kind: "deny", handoffId: null, code: "POLICY_ERROR" };
  if (isDenial(verdict)) return { kind: "deny", handoffId: null, code: "POLICY_DENIED" };
  const request = verdict;
  const status = await trigger.forcePause(request);
  switch (status.status) {
    case "resumed":
      return status.outcome === "approve"
        ? { kind: "proceed", handoffId: status.handoffId }
        : { kind: "skip", handoffId: status.handoffId };
    case "rejected":
      return { kind: "deny", handoffId: status.handoffId, code: "HUMAN_REJECTED" };
    case "ended":
      return { kind: "ended", code: status.code };
    case "refused":
      return { kind: "deny", handoffId: null, code: status.code };
    case "paused":
      // forcePause never returns paused; treat it as not cleared.
      return { kind: "deny", handoffId: status.handoffId, code: "STILL_PAUSED" };
  }
}
