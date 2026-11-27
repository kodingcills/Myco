/**
 * Track O on track N's seam: a `PolicyDenial` from `HandoffPolicy.evaluate` refuses the action
 * with `POLICY_DENIED` and opens no handoff; a malformed verdict fails closed.
 */
import { describe, expect, it } from "vitest";
import { guardAction, type HandoffPolicy } from "../../src/handoff/policy.ts";
import { brokerSetup } from "./helpers.ts";

describe("N's guardAction with O's denial", () => {
  it("a PolicyDenial is deny/POLICY_DENIED, with no handoff opened", async () => {
    const s = brokerSetup();
    const policy: HandoffPolicy = {
      id: "o.deny",
      evaluate: () => ({ deny: true, policyId: "pol-0123456789ab" }),
    };
    expect(await guardAction(policy, s.trigger, { tool: "act", args: {} })).toEqual({
      kind: "deny",
      handoffId: null,
      code: "POLICY_DENIED",
    });
    expect(s.operator.pending()).toEqual([]);
    expect(s.broker.log().entries).toEqual([]);
  });

  it("an async denial is honoured the same way", async () => {
    const s = brokerSetup();
    const policy: HandoffPolicy = {
      id: "o.deny",
      evaluate: async () => ({ deny: true, policyId: "pol-0123456789ab" }),
    };
    expect(await guardAction(policy, s.trigger, { tool: "act", args: {} })).toMatchObject({
      kind: "deny",
      code: "POLICY_DENIED",
    });
  });

  it("a verdict that is neither null nor an object fails closed", async () => {
    const s = brokerSetup();
    for (const v of [undefined, "allow", 1, true]) {
      const policy = { id: "o.bad", evaluate: () => v } as unknown as HandoffPolicy;
      expect(await guardAction(policy, s.trigger, { tool: "act", args: {} })).toMatchObject({
        kind: "deny",
        code: "POLICY_ERROR",
      });
    }
  });
});
