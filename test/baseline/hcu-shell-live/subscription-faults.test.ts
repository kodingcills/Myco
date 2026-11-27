/**
 * TIF-268 round 2 (verifier D1): the hcu+shell planner's fault classes are the myco-gate arm's
 * round-2 classes (#598 head 13fccd96). #598's own vectors are pinned here; once #598 merges and
 * the pilot transport exports its vocabulary, the expressions are compared directly, so the two
 * arms cannot drift. Pure: no spawn, no network.
 */
import { describe, expect, it } from "vitest";
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

/** #598's `USAGE_LIMIT_PHRASES` (test/pilot/helpers.ts @ 13fccd96). */
const USAGE_LIMIT_PHRASES = [
  "Claude AI usage limit reached|1700000000",
  "Claude usage limit reached. Your limit will reset at 3pm (America/New_York).",
  "5-hour limit reached ∙ resets 3pm",
  "5 hour limit reached",
  "Weekly limit reached ∙ resets Mon",
  "weekly limit reached",
  "Opus limit reached ∙ resets 11pm",
  "Sonnet limit reached · resets 3pm",
  "Your limit will reset at 5pm",
  "Limit resets at 9am",
  "daily limit exceeded",
  "usage_limit_reached",
];

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
