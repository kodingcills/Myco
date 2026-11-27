/**
 * TIF-268 round 2 (verifier D1): the hcu+shell planner's fault classes are the myco-gate arm's
 * round-2/3 classes (#598 head fc01e69a). #598's own vectors are pinned here; once #598 merges and
 * the pilot transport exports its vocabulary, the expressions are compared directly, so the two
 * arms cannot drift. Pure: no spawn, no network.
 */
import { describe, expect, it } from "vitest";
import {
  PlannerHalt,
  PlannerTransient,
  readPlannerCall,
  SubscriptionPlannerFailure,
} from "../../../src/baseline/hcu-shell-live/planner.ts";
import {
  BILLING_TEXT,
  classOfStatus,
  classOfText,
  failedCallClass,
  PER_TRIAL_CLASSES,
  RATE_LIMIT_TEXT,
  structuredClass,
  USAGE_LIMIT_TEXT,
} from "../../../src/baseline/hcu-shell-live/subscription-faults.ts";
import * as transport from "../../../src/pilot/claude-transport.ts";
import { init, result, stream, USAGE_LIMIT_PHRASES, VERDICT_QUOTA_TEXTS } from "./helpers.ts";

describe("#598 round 2's text vocabulary, pinned", () => {
  it("transient limits are rate-limit", () => {
    for (const t of [
      "API Error: 429 rate_limit_error",
      "API Error: 529 overloaded_error",
      "Too many requests",
      "Rate limit exceeded",
      "rate_limit reached, retry later",
      "Overloaded",
    ])
      expect([t, classOfText(t)]).toEqual([t, "rate-limit"]);
  });
  it("the subscription's quota wording is usage-limit", () => {
    for (const t of USAGE_LIMIT_PHRASES) expect([t, classOfText(t)]).toEqual([t, "usage-limit"]);
  });
  it("credit, billing, quota and 402 wording is billing", () => {
    for (const t of [
      "You're out of extra usage",
      "Credit balance is too low",
      "quota exceeded",
      "API Error: 402 Payment Required",
      "Your credits are exhausted",
      "Insufficient credit to continue",
      "billing_error: your plan is suspended for billing",
      "Payment required",
    ])
      expect([t, classOfText(t)]).toEqual([t, "billing"]);
  });
  it("login wording is auth; ordinary text is nothing", () => {
    for (const t of [
      "Invalid API key · Please run /login",
      "OAuth token has expired. Please obtain a new token or refresh your existing token.",
      "Not logged in",
      "API Error: 401 authentication_error",
      "403 Forbidden",
    ])
      expect([t, classOfText(t)]).toEqual([t, "auth"]);
    for (const t of ["I edited cell B2 to 42.", "The document is saved.", "Opened the sheet."])
      expect([t, classOfText(t)]).toEqual([t, null]);
  });
  it("pins the order: auth, billing, usage-limit, rate-limit", () => {
    expect(classOfText("Credit balance is too low · Please run /login")).toBe("auth");
    expect(classOfText("Weekly limit reached; billing will resume")).toBe("billing");
    expect(classOfText("429 rate_limit_error: usage limit reached")).toBe("usage-limit");
  });
});

describe("structured classes", () => {
  it("maps HTTP statuses as #598 does, 402 included", () => {
    expect([401, 402, 403, 429, 529, 500].map(classOfStatus)).toEqual([
      "auth",
      "billing",
      "auth",
      "rate-limit",
      "rate-limit",
      "error-result",
    ]);
  });
  it("auth outranks billing outranks rate-limit", () => {
    const m = (error: string) => ({ type: "assistant", message: {}, error });
    expect(structuredClass([m("billing_error"), m("authentication_failed")])).toBe("auth");
    expect(structuredClass([m("rate_limit"), m("billing_error")])).toBe("billing");
    expect(structuredClass([m("rate_limit"), m("something_new")])).toBe("rate-limit");
    expect(structuredClass([m("something_new")])).toBe("error-result");
  });
  it("a structured limit is the usage quota when the failed run's text names it", () => {
    const msgs = [{ type: "assistant", message: {}, error: "rate_limit" }];
    for (const t of USAGE_LIMIT_PHRASES)
      expect([t, failedCallClass(msgs, { result: t }, "")]).toEqual([t, "usage-limit"]);
    expect(failedCallClass(msgs, { result: "Too many requests" }, "")).toBe("rate-limit");
    expect(failedCallClass(msgs, null, "Weekly limit reached")).toBe("usage-limit");
  });
  it("only an unclassified error result and unreadable output are per-trial", () => {
    expect([...PER_TRIAL_CLASSES].sort()).toEqual(["error-result", "transport-error"]);
    expect(failedCallClass([], null, "")).toBe("transport-error");
    expect(failedCallClass([], { result: "odd" }, "")).toBe("error-result");
  });
});

describe("parity with the pilot transport once #598 merges", () => {
  const t = transport as unknown as Record<string, unknown>;
  it.runIf("USAGE_LIMIT_TEXT" in t)(
    "the expressions are the pilot transport's own (merged #598)",
    () => {
      expect(String(USAGE_LIMIT_TEXT)).toBe(String(t.USAGE_LIMIT_TEXT));
      expect(String(BILLING_TEXT)).toBe(String(t.BILLING_TEXT));
      expect(String(RATE_LIMIT_TEXT)).toBe(String(t.RATE_LIMIT_TEXT));
    },
  );
  it("before #598 merges, main's pilot classifier is untouched by this PR", () => {
    // Main's broad RATE_LIMIT_TEXT still covers billing wording (the pilot runner on main
    // backs off on it); this arm does not change pilot behaviour.
    if (!("USAGE_LIMIT_TEXT" in t))
      expect(transport.classOfText("Credit balance is too low")).toBe("rate-limit");
  });
});

/**
 * Round 3 (verifier "Parity"): BEHAVIOUR, not only regex strings. #598's `interpretResult`
 * vectors at fc01e69a (`test/pilot/claude-transport.test.ts`: R2-D3a plain stdout, R2-D3b
 * claimless clean quota, the claim-line negatives, the 401/403/429 task-data negatives, the
 * round-1 probes) run through this arm's `readPlannerCall`. Each vector names #598's class; the
 * arm must reach the matching outcome. A `DONE` / `NOT DONE` claim line in #598 is a valid
 * parseable decision here (`decisionWith`). Once #598 merges (the pilot transport exports
 * `USAGE_LIMIT_TEXT`), the same table is also run through #598's own `interpretResult`, so the
 * table itself cannot drift from the gate arm.
 */
type Outcome598 =
  | "none"
  | "usage-limit"
  | "auth"
  | "billing"
  | "rate-limit"
  | "transport-error"
  | "error-result";
type Channel = "clean" | "claimed" | "error" | "plain" | "stderr";
interface Vector {
  readonly text: string;
  readonly channel: Channel;
  readonly code: number;
  readonly expected: Outcome598;
}

const price = () => 0;
/** A valid hcu+shell decision that carries `text` (a shell read of a file named by it). */
const decisionWith = (text: string) =>
  JSON.stringify({ shell: "cat", path: `C:\\Users\\Public\\${text.replace(/\n/g, " ")}.txt` });

const hcuInput = (v: Vector): [string, string, number] => {
  switch (v.channel) {
    case "clean":
      return [stream(init(), result(v.text)), "", v.code];
    case "claimed":
      return [stream(init(), result(decisionWith(v.text))), "", v.code];
    case "error":
      return [stream(init(), result(v.text, { is_error: true })), "", v.code];
    case "plain":
      return [v.text, "", v.code];
    case "stderr":
      return ["", v.text, v.code];
  }
};
const input598 = (v: Vector): [string, string, number] => {
  const r = (text: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, ...extra });
  switch (v.channel) {
    case "clean":
      return [r(v.text), "", v.code];
    case "claimed":
      return [r(`${v.text}\nDONE`), "", v.code];
    case "error":
      return [r(v.text, { is_error: true }), "", v.code];
    case "plain":
      return [v.text, "", v.code];
    case "stderr":
      return ["", v.text, v.code];
  }
};

function hcuOutcome(stdout: string, stderr: string, code: number): Outcome598 | string {
  try {
    readPlannerCall(stdout, stderr, code, price);
    return "none";
  } catch (e) {
    if (e instanceof PlannerTransient) return "rate-limit";
    if (e instanceof PlannerHalt)
      return (
        (
          {
            "planner-usage-limit": "usage-limit",
            "planner-auth": "auth",
            "planner-billing": "billing",
          } as Record<string, string>
        )[e.code] ?? e.code
      );
    if (e instanceof SubscriptionPlannerFailure) return e.code.replace(/^planner-/, "");
    return "other";
  }
}

/** #598 @ fc01e69a, `claude-transport.test.ts`, every round-3 and D4 vector, by channel. */
const QUOTAISH = [
  "Done — the weekly limit column is fixed.",
  "The pay period resets on Mon 3 March.",
  "Set the API key column header and the OAuth flag; usage limit noted in B4.",
];
const D4_PROBES = [
  "I updated the billing totals in column C.",
  "Fixed the quota column. Done.",
  "The cell was locked (forbidden). I stopped.",
  "I set the credential column to blank.",
  "I looked at EMP-0055: its qty is 429. I could not save the file.",
  "Row EMP-0127 has qty 401; I left it unchanged.",
  "EMP-0090 qty 403 is now 430.",
  "Invalid API key · Please run /login",
];
const TASK_DATA = ["qty 429 on EMP-0055", "EMP-0127 401, EMP-0090 403", "429\n401\n403"];
const ROUND1 = [
  ["Claude AI usage limit reached|1700000000", "usage-limit"],
  ["Sonnet limit reached · resets 3pm", "usage-limit"],
  ["5-hour limit reached ∙ resets 3pm", "usage-limit"],
  ["Weekly limit reached ∙ resets Mon", "usage-limit"],
  ["Invalid API key · Please run /login", "auth"],
] as const;

const quotaTexts = [...USAGE_LIMIT_PHRASES, ...VERDICT_QUOTA_TEXTS, ...QUOTAISH];
const PARITY_VECTORS: readonly Vector[] = [
  // R2-D3b: a clean result with no claim / no decision that names the quota stops the run.
  ...quotaTexts.map((text) => ({
    text,
    channel: "clean" as const,
    code: 0,
    expected: "usage-limit" as const,
  })),
  // ...and with a claim line / a valid decision it is never reclassified.
  ...quotaTexts.map((text) => ({
    text,
    channel: "claimed" as const,
    code: 0,
    expected: "none" as const,
  })),
  // R2-D3a: plain (non-JSON) stdout, exit 1 and exit 0.
  ...[1, 0].flatMap((code) => [
    ...[...USAGE_LIMIT_PHRASES, ...VERDICT_QUOTA_TEXTS].map((text) => ({
      text,
      channel: "plain" as const,
      code,
      expected: "usage-limit" as const,
    })),
    { text: "not json", channel: "plain" as const, code, expected: "transport-error" as const },
  ]),
  // D4 and task data: the broad vocabulary never reaches a clean result.
  ...[...D4_PROBES, ...TASK_DATA].map((text) => ({
    text,
    channel: "clean" as const,
    code: 0,
    expected: "none" as const,
  })),
  // The fallback still fires when the same run did NOT complete normally.
  { text: D4_PROBES[4] as string, channel: "clean", code: 1, expected: "rate-limit" },
  { text: D4_PROBES[5] as string, channel: "clean", code: 1, expected: "auth" },
  // Round 1: every limit and login probe, on an error result, an unflagged non-zero result and
  // bare stderr.
  ...ROUND1.flatMap(([text, expected]) => [
    { text, channel: "error" as const, code: 1, expected },
    { text, channel: "clean" as const, code: 1, expected },
    { text, channel: "stderr" as const, code: 1, expected },
  ]),
];

describe("behavioural parity with #598's interpretResult @ fc01e69a (round 3)", () => {
  it("covers every vector family the verdict names", () => {
    const channels = new Set(PARITY_VECTORS.map((v) => `${v.channel}:${v.expected}`));
    for (const c of [
      "clean:usage-limit",
      "claimed:none",
      "plain:usage-limit",
      "plain:transport-error",
      "clean:none",
    ])
      expect(channels.has(c), c).toBe(true);
    expect(PARITY_VECTORS.length).toBeGreaterThan(90);
  });
  it.each(PARITY_VECTORS.map((v) => [v.channel, v.code, v.text, v] as const))(
    "%s exit %d %j reaches #598's outcome through readPlannerCall",
    (_c, _code, _t, v) => {
      expect(hcuOutcome(...hcuInput(v))).toBe(v.expected);
    },
  );
  const t = transport as unknown as Record<string, unknown>;
  it.runIf("USAGE_LIMIT_TEXT" in t)(
    "the same table through the merged #598 interpretResult (the table cannot drift)",
    () => {
      const interpret = t.interpretResult as (s: string, e: string, c: number) => unknown;
      for (const v of PARITY_VECTORS) {
        let got: string;
        try {
          interpret(...input598(v));
          got = "none";
        } catch (e) {
          got = String((e as { harnessClass?: unknown }).harnessClass ?? "other");
        }
        expect([v.channel, v.text, got]).toEqual([v.channel, v.text, v.expected]);
      }
    },
  );
});
