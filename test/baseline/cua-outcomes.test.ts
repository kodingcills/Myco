/**
 * TIF-167: the four outcomes of a Cua action must stay distinct.
 *
 * The defect these lock down: `C1.execute` returned
 * `refused: result.isError === true || effect === "refused"`, which collapsed a
 * delivery-layer refusal, a delivered action, a stalled confirmation, and a
 * failed save into one boolean. arm-003c's `cua-action-refused` was read as the
 * model failing to save for a day, when it was the routing layer declining to
 * send the key at all - the probe on 2026-11-23 settled that background
 * `key_combo` on a SALFRAME window is refused identically for Ctrl+S and
 * Ctrl+F12.
 *
 * Each test stubs one raw Cua response. The bodies are copied from the probe's
 * real captures where one exists, so the fixtures are the shapes the driver
 * actually returns rather than shapes invented to fit the parser.
 */
import { describe, expect, it } from "vitest";
import { connectC1, type Mcp } from "../../src/baseline/c1.ts";

const WINDOW = { pid: 3152, window_id: 328170 };

/** A Cua whose every response is scripted, recording each call. */
function stubCua(responses: unknown[]): {
  mcp: Mcp;
  calls: { name: string; arguments: Record<string, unknown> }[];
} {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  let index = 0;
  const mcp: Mcp = {
    async request(method, params) {
      if (method === "initialize") return { protocolVersion: "2025-11-25" };
      if (method === "notifications/initialized") return {};
      const { name, arguments: args } = params as {
        name: string;
        arguments: Record<string, unknown>;
      };
      calls.push({ name, arguments: args });
      return responses[Math.min(index++, responses.length - 1)];
    },
    async notify() {},
  };
  return { mcp, calls };
}

const KEY_ACTION = {
  tool: "press_key",
  arguments: { x: 0, y: 0, key: "Ctrl+s" },
} as const;

/** The real refusal, as captured from the guest on 2026-11-23. */
const BACKGROUND_UNAVAILABLE = {
  isError: true,
  structuredContent: {
    code: "background_unavailable",
    effect: "refused",
    event_kind: "key_combo",
    target_class: "SALFRAME",
    escalation: { recommended: "foreground" },
  },
};

/** The real stall, as captured after a foreground retry. */
const DELIVERY_STALLED = {
  isError: true,
  structuredContent: { code: "tool_invocation_failed", foreground_restored: false },
};

const DELIVERED = { isError: false, structuredContent: { effect: "applied", verified: true } };

async function executeOnce(responses: unknown[]) {
  const { mcp, calls } = stubCua(responses);
  const c1 = await connectC1(mcp, WINDOW);
  const result = await c1.execute(KEY_ACTION);
  return { result, calls };
}

describe("Cua action outcomes", () => {
  it("escalates background_unavailable to foreground exactly once", async () => {
    const { result, calls } = await executeOnce([BACKGROUND_UNAVAILABLE, DELIVERED]);
    expect(result.outcome).toBe("delivered");
    expect(result.deliveryMode).toBe("foreground");
    expect(result.escalated).toBe(true);
    // Exactly two calls: one background, one foreground. Not three.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.arguments.delivery_mode).toBeUndefined();
    expect(calls[1]!.arguments.delivery_mode).toBe("foreground");
  });

  it("records background delivery when no escalation was needed", async () => {
    const { result, calls } = await executeOnce([DELIVERED]);
    expect(result.outcome).toBe("delivered");
    expect(result.deliveryMode).toBe("background");
    expect(result.escalated).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("reports a stall as delivered-stalled and does not retry", async () => {
    // A stall means the input landed and its effect is unconfirmed. Retrying
    // would duplicate it - Cua's own message says inspect the target first.
    const { result, calls } = await executeOnce([BACKGROUND_UNAVAILABLE, DELIVERY_STALLED]);
    expect(result.outcome).toBe("delivered-stalled");
    expect(result.deliveryMode).toBe("foreground");
    expect(calls).toHaveLength(2);
  });

  it("does not escalate a refusal that is not background_unavailable", async () => {
    // An unexpected refusal has no documented retry. Escalating would retry
    // something unfixable and hide the real fault.
    const { result, calls } = await executeOnce([
      { isError: true, structuredContent: { effect: "refused" } },
    ]);
    expect(result.outcome).toBe("routing-refused");
    expect(result.escalated).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("never counts a routing refusal as a delivered action", async () => {
    const { result } = await executeOnce([BACKGROUND_UNAVAILABLE, BACKGROUND_UNAVAILABLE]);
    expect(result.outcome).toBe("routing-refused");
    expect(result.deliveryMode).toBe("foreground");
    expect(result.escalated).toBe(true);
  });

  it("keeps verified alongside the outcome rather than in place of it", async () => {
    const { result } = await executeOnce([DELIVERED]);
    expect(result.verified).toBe(true);
    expect(result.outcome).toBe("delivered");
  });
});
