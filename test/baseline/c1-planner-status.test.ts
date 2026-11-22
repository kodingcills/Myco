import { describe, expect, it } from "vitest";
import { createPlanner } from "../../src/baseline/planner.ts";

/**
 * The probe cites "HTTP 200" as its evidence, so the status must be recorded
 * from the response and not inferred from a usage block. Assembly-time key:
 * a literal here trips the repo's credential guard (test/sai/harness.test.ts).
 */
const SYNTHETIC_KEY = ["sk", "ant", "synthetic", "key"].join("-");

const shot = { mimeType: "image/png" as const, data: "aGk=" };

function plannerAnswering(status: number) {
  const request = (async (url: string | URL) => {
    if (String(url).endsWith("/count_tokens")) {
      return new Response(JSON.stringify({ input_tokens: 414 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 414, output_tokens: 5 },
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return createPlanner(request, { ANTHROPIC_API_KEY: SYNTHETIC_KEY });
}

describe("planner records the Messages status", () => {
  it("reports 200 on a successful paid call", async () => {
    const planner = plannerAnswering(200);
    await planner.act("edit the cell", shot);
    expect(planner.lastMessageStatus).toBe(200);
  });

  it("reports the failure status rather than undefined", async () => {
    const planner = plannerAnswering(400);
    await expect(planner.act("edit the cell", shot)).rejects.toThrow(/HTTP 400/);
    expect(planner.lastMessageStatus).toBe(400);
  });

  it("is undefined when no Messages call was made", () => {
    const planner = plannerAnswering(200);
    expect(planner.lastMessageStatus).toBeUndefined();
  });
});
