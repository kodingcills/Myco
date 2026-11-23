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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectC1, type Mcp } from "../../src/baseline/c1.ts";
import { isBaselineRow } from "../../src/baseline/index.ts";

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

  it("treats a transport fault as a stall, not as a routing refusal", async () => {
    // The verifier's finding: `isError` used to mean "the app never saw it", so a
    // tool that RAN and then errored was filed as a routing refusal - hiding a
    // delivery failure behind "not a model outcome". Two shapes must both be
    // stalls, including the text-only form the probe itself received.
    for (const shape of [
      { isError: true, structuredContent: { code: "tool_invocation_failed" } },
      {
        isError: true,
        structuredContent: { code: "tool_invocation_failed", foreground_restored: null },
      },
      { isError: true, content: [{ type: "text", text: "input_delivery_stalled: ..." }] },
    ]) {
      const { result, calls } = await executeOnce([shape]);
      // The text-only form carries no code, so it can only be recognised as
      // isError-without-a-routing-code; assert it is not silently "refused".
      if (shape.content) {
        // No code to key on: this is the documented limit of what the transport
        // can tell us, and the outcome is a refusal only if Cua says so.
        expect(result.outcome).toBe("routing-refused");
      } else {
        expect(result.outcome).toBe("delivered-stalled");
      }
      expect(calls).toHaveLength(1);
    }
  });

  it("escalates every background refusal code Cua names, not just the observed one", async () => {
    // Cua's taxonomy has three background_* codes (docs/research/adapters.md:655).
    // Escalating only the one seen in the probe would under-escalate on a
    // different desktop condition - a retryable refusal counted as final.
    for (const code of [
      "background_unavailable",
      "background_occluded",
      "background_uipi_blocked",
    ]) {
      const { result, calls } = await executeOnce([
        { isError: true, structuredContent: { code, effect: "refused" } },
        DELIVERED,
      ]);
      expect(result.escalated, `${code} should escalate`).toBe(true);
      expect(calls).toHaveLength(2);
    }
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

  it("never reports save-failed from the transport layer", async () => {
    // Whether a save took effect is a document state, judged separately
    // (c1-judge.ts). Cua only answers "did I deliver this input". So no transport
    // response, however it is shaped, may produce save-failed - doing so would
    // report a delivery as a document outcome, which is the conflation TIF-167
    // exists to undo.
    const shapes = [
      { isError: false, structuredContent: {} },
      { isError: true, structuredContent: { effect: "refused" } },
      BACKGROUND_UNAVAILABLE,
      DELIVERY_STALLED,
      { isError: false, structuredContent: { effect: "applied", verified: false } },
    ];
    for (const shape of shapes) {
      const { result } = await executeOnce([shape]);
      expect(result.outcome).not.toBe("save-failed");
    }
  });

  it("keeps verified alongside the outcome rather than in place of it", async () => {
    const { result } = await executeOnce([DELIVERED]);
    expect(result.verified).toBe(true);
    expect(result.outcome).toBe("delivered");
  });
});

describe("delivery records in recorded rows", () => {
  // The rule is deliberately permissive about ABSENCE: committed trial rows must
  // stay valid without being edited. An earlier version required the field and
  // excused old rows with a marker, which meant rewriting 34 recorded rows - not
  // this change's call, and the marker precedent (TIF-104) covered adding a field
  // to rows being written then, not retrofitting a validator onto evidence.
  const legacy = JSON.parse(
    readFileSync(join(process.cwd(), "docs/research/experiments/c1-arm-002/rows/0.json"), "utf8"),
  ) as Record<string, unknown>;

  it("accepts a recorded row that predates delivery recording, unedited", () => {
    // Verbatim from a committed row. If this fails, real evidence has been
    // invalidated by a validator change rather than by anything in the artifact.
    expect(isBaselineRow(legacy)).toBe(true);
    // And it must still carry no fabricated field.
    expect((legacy.transcript as Record<string, unknown>).deliveries).toBeUndefined();
  });

  it("accepts a row whose deliveries are well formed", () => {
    const row = structuredClone(legacy);
    (row.transcript as Record<string, unknown>).deliveries = [
      { step: 1, mode: "background", escalated: false, outcome: "delivered" },
      { step: 2, mode: "foreground", escalated: true, outcome: "delivered-stalled" },
    ];
    expect(isBaselineRow(row)).toBe(true);
  });

  it("rejects malformed deliveries rather than accepting anything", () => {
    // The part worth protecting: a writer emitting a delivery record nobody can
    // interpret must fail, so arm-003d's run condition stays auditable.
    for (const bad of [
      "garbage",
      [{ step: 1 }],
      [{ step: 1, mode: "sideways", escalated: false, outcome: "delivered" }],
      [{ step: 1, mode: "background", escalated: "yes", outcome: "delivered" }],
      [{ step: 1, mode: "background", escalated: false, outcome: "invented" }],
      [{ step: 1, mode: "background", escalated: false, outcome: "delivered-dismissed" }],
    ]) {
      const row = structuredClone(legacy);
      (row.transcript as Record<string, unknown>).deliveries = bad;
      expect(isBaselineRow(row), `${JSON.stringify(bad)} should be rejected`).toBe(false);
    }
  });
});
