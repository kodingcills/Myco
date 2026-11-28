import { describe, expect, it } from "vitest";
import { createPlanner, PlannerFailure } from "../../src/baseline/planner.ts";

/**
 * A response cut off at the output ceiling must not be scored as an agent
 * decision (TIF-164).
 *
 * Found in arm-003d r2: trials 3 and 4 both scored `refuted/persisted-mismatch`
 * with ZERO steps, one model call, and a completion of exactly 256 — the ceiling.
 * `MAX_OUTPUT` was 256 and `stop_reason` was only inspected for `"refusal"`, so a
 * truncated reply became partial JSON, the planner found no decision, and
 * `planner-no-action` was recorded against the agent. A harness fault was being
 * measured as an agent failure, which deflates the baseline and stops the
 * two-consecutive-identical-failure abort from ever firing, because a truncated
 * trial does not look like a failure — it looks like a bad agent.
 *
 * Reproducible from the committed rows under
 * `docs/research/experiments/c1-arm-002/rows/` (444 calls, 29 rows): the largest
 * NON-truncated completion is 250 (row 26), and 22 calls across 22 distinct rows
 * landed on exactly 256 - the ceiling, not the model's answer.
 */
const shot = { mimeType: "image/png" as const, data: "aGk=" };
const SYNTHETIC_KEY = ["sk", "ant", "synthetic", "key"].join("-");

/** A planner whose paying call returns `body`, with Count Tokens succeeding. */
function plannerReturningMessage(body: unknown) {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const request = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    seen.push({
      url: href,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    if (href.endsWith("/count_tokens"))
      return new Response(JSON.stringify({ input_tokens: 100 }), { status: 200 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { planner: createPlanner(request, { ANTHROPIC_API_KEY: SYNTHETIC_KEY }), seen };
}

const USAGE = { input_tokens: 500, output_tokens: 256 };

describe("a truncated model reply is a harness fault, not an agent decision", () => {
  it("throws rather than returning the partial text", async () => {
    // The exact shape r2 produced: stop_reason max_tokens, partial JSON content.
    const { planner } = plannerReturningMessage({
      stop_reason: "max_tokens",
      usage: USAGE,
      content: [
        { type: "text", text: '{"tool":"type_text","arguments":{"x":75,"y":146,"text":"B3' },
      ],
    });
    await expect(planner.act("edit the cell", shot)).rejects.toThrow(PlannerFailure);
  });

  it("says WHY, naming the ceiling, so the ledger is diagnosable", async () => {
    const { planner } = plannerReturningMessage({
      stop_reason: "max_tokens",
      usage: USAGE,
      content: [{ type: "text", text: "partial" }],
    });
    try {
      await planner.act("edit the cell", shot);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PlannerFailure);
      expect((error as Error).message).toContain("truncated");
      expect((error as Error).message).toContain("max_tokens");
    }
  });

  it("still accepts a reply that ended normally", async () => {
    // The control: end_turn must NOT throw, or the fix would break every run.
    const { planner } = plannerReturningMessage({
      stop_reason: "end_turn",
      usage: USAGE,
      content: [{ type: "text", text: '{"claim":"done"}' }],
    });
    // The decision must survive, not just "something resolved": `resolves.toBeDefined()`
    // passed with the end_turn reply's decision dropped (test audit, mutation M2).
    const out = await planner.act("edit the cell", shot);
    expect(out.decision).toBe("done");
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]?.usage).toMatchObject({ prompt: 500, completion: 256 });
  });

  it("asks for enough output that a real answer is not clipped", async () => {
    // The ceiling itself: 256 was clipping responses of 250+ observed tokens.
    // Asserted as a floor with headroom rather than an exact number, so raising
    // it further is allowed and lowering it back to a clipping value is not.
    const { planner, seen } = plannerReturningMessage({
      stop_reason: "end_turn",
      usage: USAGE,
      content: [{ type: "text", text: '{"claim":"done"}' }],
    });
    await planner.act("edit the cell", shot);
    const pay = seen.find((s) => s.url.endsWith("/v1/messages"));
    expect(typeof pay?.body.max_tokens).toBe("number");
    expect(pay?.body.max_tokens as number).toBeGreaterThanOrEqual(512);
  });
});
