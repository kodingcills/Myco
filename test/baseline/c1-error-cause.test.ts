import { describe, expect, it } from "vitest";
import { createPlanner, PlannerFailure } from "../../src/baseline/planner.ts";

/**
 * A 400 must arrive with its cause. The C1 spike produced
 * "HTTP 400 (unknown error type)" and nothing else, because the message text
 * was only kept for error types already on an allowlist that omitted every one
 * of the API's documented 400 codes.
 */
const shot = { mimeType: "image/png" as const, data: "aGk=" };

function plannerReturning(status: number, body: unknown) {
  const calls: string[] = [];
  const request = (async (url: string | URL) => {
    const href = String(url);
    calls.push(href);
    // Count Tokens must succeed so the paying call is reached.
    if (href.endsWith("/count_tokens")) {
      return new Response(JSON.stringify({ input_tokens: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { planner: createPlanner(request, { ANTHROPIC_API_KEY: "sk-ant-synthetic-key" }), calls };
}

/** `act` throws PlannerFailure on an unverifiable paid call; capture the text. */
async function failureText(planner: ReturnType<typeof createPlanner>) {
  try {
    await planner.act("edit the cell", shot);
  } catch (error) {
    if (error instanceof PlannerFailure) return error.message;
    throw error;
  }
  throw new Error("expected act() to throw");
}

describe("C1 planner surfacing of API errors", () => {
  const cases: [string, string][] = [
    ["image_dimensions_too_large", "image too large"],
    ["request_body_encoding_unsupported", "encoding"],
    ["tool_name_conflict", "conflict"],
    ["ramp_limit_exceeded", "ramp"],
  ];

  it.each(cases)("keeps the scrubbed cause for documented 400 %s", async (type, message) => {
    const { planner, calls } = plannerReturning(400, { error: { type, message } });
    const failure = await failureText(planner);
    expect(calls.some((u) => u.endsWith("/v1/messages"))).toBe(true);
    expect(failure).toContain("HTTP 400");
    expect(failure).toContain(type); // the type is named, not swallowed
    expect(failure).toContain(message); // and so is the cause
  });

  it("keeps the cause even when the type is not recognised at all", async () => {
    const { planner } = plannerReturning(400, {
      error: { type: "some_future_code", message: "a cause we have never seen" },
    });
    const failure = await failureText(planner);
    expect(failure).toContain("HTTP 400");
    expect(failure).toContain("a cause we have never seen");
  });

  it("never leaks the API key through a 400 message", async () => {
    const key = "sk-ant-synthetic-key";
    const { planner } = plannerReturning(400, {
      error: {
        type: "invalid_request_error",
        message: `bad key ${key}\n anthropic-beta: secret-value`,
      },
    });
    const failure = await failureText(planner);
    expect(failure).toContain("HTTP 400");
    expect(failure).not.toContain(key);
    expect(failure).not.toContain("secret-value");
  });

  it("sends max_tokens on the paying call but not on Count Tokens", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const request = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (String(url).endsWith("/count_tokens"))
        return new Response(JSON.stringify({ input_tokens: 100 }), { status: 200 });
      return new Response(JSON.stringify({ error: { type: "x", message: "y" } }), { status: 400 });
    }) as unknown as typeof fetch;
    const p2 = createPlanner(request, { ANTHROPIC_API_KEY: "sk-ant-synthetic-key" });
    await failureText(p2);
    const count = seen.find((s) => s.url.endsWith("/count_tokens"));
    const pay = seen.find((s) => s.url.endsWith("/v1/messages"));
    expect(count?.body).not.toHaveProperty("max_tokens"); // Count Tokens takes the message body
    expect(pay?.body).toHaveProperty("max_tokens"); // required on create
  });
});
