/**
 * TIF-268: the hcu+shell planner's fault classes ARE the myco-gate arm's (#598 + #607). Round 4
 * (lead rulings 03:58Z and 05:39Z): the arm holds no copy of the classifier; it imports it from
 * `src/pilot/claude-cli.ts`, which `src/pilot/claude-transport.ts` re-exports. This file pins:
 *  - that `subscription-faults.ts` has no vocabulary, fold or structured table of its own and
 *    delegates to the very same functions;
 *  - the myco-gate arm's own vectors (`test/pilot/helpers.ts`, #607) run through this arm's
 *    `readPlannerCall`, compared with the myco-gate arm's `interpretResult` on the same input;
 *  - the round-3 behavioural parity table, now also run through the merged `interpretResult`.
 * Pure: no spawn, no network.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  PlannerHalt,
  PlannerTransient,
  readPlannerCall,
  SubscriptionPlannerFailure,
} from "../../../src/baseline/hcu-shell-live/planner.ts";
import {
  failedCallClass,
  PER_TRIAL_CLASSES,
  undecidedCleanCallClass,
} from "../../../src/baseline/hcu-shell-live/subscription-faults.ts";
import * as transport from "../../../src/pilot/claude-transport.ts";
import {
  CLEAN_RESULT_FAULT_PHRASES,
  CLEAN_RESULT_TASK_DATA,
  FAULT_WORDING,
  FOLDED_USAGE_PHRASES,
  USAGE_LIMIT_PHRASES as MAIN_USAGE_LIMIT_PHRASES,
  NBSP,
  spaced,
  THIN_SPACE,
  UNICODE_SPACES,
  UNMAPPED_STRUCTURED,
} from "../../pilot/helpers.ts";
import { init, result, stream, USAGE_LIMIT_PHRASES, VERDICT_QUOTA_TEXTS } from "./helpers.ts";

const FAULTS_FILE = "src/baseline/hcu-shell-live/subscription-faults.ts";
const PLANNER_FILE = "src/baseline/hcu-shell-live/planner.ts";

/** Every node of `file` for which `pick` returns a value. */
function nodes<T>(file: string, pick: (n: ts.Node) => T | undefined): T[] {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out: T[] = [];
  const walk = (n: ts.Node) => {
    const v = pick(n);
    if (v !== undefined) out.push(v);
    ts.forEachChild(n, walk);
  };
  walk(src);
  return out;
}

describe("one classifier: the arm imports the myco-gate arm's, it holds no copy (round 4)", () => {
  it.each([FAULTS_FILE, PLANNER_FILE])("%s has no regular expression of its own", (file) => {
    // The usage-limit / billing / auth / transient vocabularies and the whitespace fold are all
    // regular expressions; none may live in the arm's classification modules.
    const regexes = nodes(file, (n) =>
      n.kind === ts.SyntaxKind.RegularExpressionLiteral ? n.getText() : undefined,
    );
    const ctor = nodes(file, (n) =>
      ts.isNewExpression(n) && n.expression.getText() === "RegExp" ? n.getText() : undefined,
    );
    expect([...regexes, ...ctor]).toEqual([]);
  });
  it("subscription-faults.ts takes its classifier from the pilot's claude-cli.ts only", () => {
    const imports = nodes(FAULTS_FILE, (n) =>
      ts.isImportDeclaration(n) ? (n.moduleSpecifier as ts.StringLiteral).text : undefined,
    );
    expect(imports.sort()).toEqual(["../../pilot/claude-cli.ts", "../../pilot/ledger.ts"]);
    const named = nodes(FAULTS_FILE, (n) =>
      ts.isImportDeclaration(n) &&
      (n.moduleSpecifier as ts.StringLiteral).text === "../../pilot/claude-cli.ts"
        ? n.importClause?.namedBindings?.getText()
        : undefined,
    ).join(" ");
    for (const f of ["classOfUncleanRun", "classOfClaimlessCleanResult", "apiKeySourceProblem"])
      expect(named).toContain(f);
  });
  it("the pilot transport re-exports the very same classifier functions", async () => {
    const cli = await import("../../../src/pilot/claude-cli.ts");
    expect(transport.classOfUncleanRun).toBe(cli.classOfUncleanRun);
    expect(transport.classOfClaimlessCleanResult).toBe(cli.classOfClaimlessCleanResult);
    expect(transport.classOfFailure).toBe(cli.classOfFailure);
    expect(transport.namesUsageLimit).toBe(cli.namesUsageLimit);
    expect(transport.USAGE_LIMIT_TEXT).toBe(cli.USAGE_LIMIT_TEXT);
    expect(transport.interpretResult).toBe(cli.interpretResult);
  });
  it("only an unclassified error result and unreadable output are per-trial", () => {
    expect([...PER_TRIAL_CLASSES].sort()).toEqual(["error-result", "transport-error"]);
    expect(failedCallClass([], null, "", "", 1)).toBe("transport-error");
    expect(failedCallClass([], { result: "odd" }, "", "", 1)).toBe("error-result");
    const clean = { type: "result", subtype: "success", is_error: false, result: "x" };
    expect(failedCallClass([clean], clean, "", "", 0)).toBeNull();
  });
  it("a structured limit is the usage quota when the failed run's text names it", () => {
    const msgs = [{ type: "assistant", message: {}, error: "rate_limit" }];
    for (const t of MAIN_USAGE_LIMIT_PHRASES)
      expect([t, failedCallClass(msgs, { result: t }, "", "", 1)]).toEqual([t, "usage-limit"]);
    expect(failedCallClass(msgs, { result: "Too many requests" }, "", "", 1)).toBe("rate-limit");
    expect(failedCallClass(msgs, null, "Weekly limit reached", "", 1)).toBe("usage-limit");
  });
  it("undecidedCleanCallClass reads the text and stderr together", () => {
    expect(undecidedCleanCallClass("", "You've hit your limit")).toBe("usage-limit");
    expect(undecidedCleanCallClass("Not logged in", "")).toBe("auth");
    expect(undecidedCleanCallClass("", `Credit${NBSP}balance is too low`)).toBe("billing");
    expect(undecidedCleanCallClass("qty 429; HTTP 401", "403 forbidden")).toBeNull();
  });
});

const price = () => 0;

/** This arm's outcome for one call, as the myco-gate arm's class names it ("none": a turn). */
function hcuOutcome(stdout: string, stderr: string, code: number | null): string {
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

/** The myco-gate arm's outcome for one call (`interpretResult`), in the same terms. */
function gateOutcome(stdout: string, stderr: string, code: number | null): string {
  try {
    transport.interpretResult(stdout, stderr, code);
    return "none";
  } catch (e) {
    return String((e as { harnessClass?: unknown }).harnessClass ?? "other");
  }
}

/** A valid hcu+shell decision that carries `text` (a shell read of a file named by it). */
const decisionWith = (text: string) =>
  JSON.stringify({ shell: "cat", path: `C:\\Users\\Public\\${text.replace(/\n/g, " ")}.txt` });
const gateResult = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, ...extra });

/**
 * One call shape, built for both arms: `hcu` is this arm's stream-json call, `gate` the
 * myco-gate arm's `--output-format json` call. A claim line there is a valid decision here.
 */
type Shape = "clean" | "clean+stderr" | "claimed" | "claimed+stderr" | "plain" | "stderr";
function both(shape: Shape, text: string, code: number | null) {
  switch (shape) {
    case "clean":
      return { hcu: [stream(init(), result(text)), "", code], gate: [gateResult(text), "", code] };
    case "clean+stderr":
      return { hcu: [stream(init(), result("")), text, code], gate: [gateResult(""), text, code] };
    case "claimed":
      return {
        hcu: [stream(init(), result(decisionWith(text))), "", code],
        gate: [gateResult(`${text}\nDONE`), "", code],
      };
    case "claimed+stderr":
      return {
        hcu: [stream(init(), result(decisionWith("B2"))), text, code],
        gate: [gateResult("DONE"), text, code],
      };
    case "plain":
      return { hcu: [text, "", code], gate: [text, "", code] };
    case "stderr":
      return { hcu: ["", text, code], gate: ["", text, code] };
  }
}
type Call = [string, string, number | null];

/**
 * The myco-gate arm's #607 vectors, through this arm: each expected outcome is asserted, and is
 * also what the myco-gate arm's own `interpretResult` gives on the same call.
 */
const MAIN_VECTORS: readonly {
  name: string;
  shape: Shape;
  text: string;
  code: number;
  want: string;
}[] = [
  // S1: every usage-limit phrase on stderr only, claimless clean result, exit 0.
  ...MAIN_USAGE_LIMIT_PHRASES.map((t) => ({
    name: `S1 ${t}`,
    shape: "clean+stderr" as const,
    text: t,
    code: 0,
    want: "usage-limit",
  })),
  // S2: every phrase with every Unicode space, clean result and plain stdout.
  ...MAIN_USAGE_LIMIT_PHRASES.flatMap((t) =>
    UNICODE_SPACES.flatMap(([label, space]) =>
      (["clean", "plain"] as const).map((shape) => ({
        name: `S2 ${label} ${shape} ${t}`,
        shape,
        text: spaced(t, space),
        code: shape === "clean" ? 0 : 1,
        want: "usage-limit",
      })),
    ),
  ),
  // F-A: format characters and hyphen variants.
  ...FOLDED_USAGE_PHRASES.flatMap(([label, t]) =>
    (["clean", "clean+stderr", "plain", "stderr"] as const).map((shape) => ({
      name: `F-A ${label} ${shape}`,
      shape,
      text: t,
      code: shape === "plain" || shape === "stderr" ? 1 : 0,
      want: "usage-limit",
    })),
  ),
  // L1: the narrow billing / auth phrases on a claimless clean result (text or stderr).
  ...CLEAN_RESULT_FAULT_PHRASES.flatMap(([t, cls]) =>
    (["clean", "clean+stderr"] as const).map((shape) => ({
      name: `L1 ${shape} ${t}`,
      shape,
      text: spaced(t, THIN_SPACE),
      code: 0,
      want: cls,
    })),
  ),
  // Negatives: a claim line / a valid decision is never reclassified.
  ...[...MAIN_USAGE_LIMIT_PHRASES, ...CLEAN_RESULT_FAULT_PHRASES.map(([t]) => t)].flatMap((t) =>
    (["claimed", "claimed+stderr"] as const).map((shape) => ({
      name: `claimed ${shape} ${t}`,
      shape,
      text: spaced(t, NBSP),
      code: 0,
      want: "none",
    })),
  ),
  // Negatives: task data (401 / 403 / 429, billing / auth words) on a clean result.
  ...CLEAN_RESULT_TASK_DATA.flatMap((t) =>
    (["clean", "clean+stderr"] as const).map((shape) => ({
      name: `task data ${shape} ${t}`,
      shape,
      text: t,
      code: 0,
      want: "none",
    })),
  ),
];

describe("the myco-gate arm's #607 vectors through readPlannerCall (round 4 parity)", () => {
  it("covers S1, S2 (NBSP, U+2009, tab), F-A, L1 and the negatives", () => {
    const names = MAIN_VECTORS.map((v) => v.name);
    for (const p of [
      "S1 ",
      "S2 U+00A0",
      "S2 U+2009",
      "S2 tab",
      "F-A ",
      "L1 ",
      "claimed ",
      "task data ",
    ])
      expect(
        names.some((n) => n.startsWith(p)),
        p,
      ).toBe(true);
    expect(MAIN_USAGE_LIMIT_PHRASES).toContain("You've hit your limit");
  });
  it.each(MAIN_VECTORS.map((v) => [v.name, v] as const))("%s", (_n, v) => {
    const call = both(v.shape, v.text, v.code);
    expect(hcuOutcome(...(call.hcu as Call))).toBe(v.want);
    expect(gateOutcome(...(call.gate as Call))).toBe(v.want);
  });
  it.each(
    UNMAPPED_STRUCTURED.flatMap(([field, extra]) =>
      FAULT_WORDING.map(([t, cls]) => [field, t, cls, extra] as const),
    ),
  )("B2: unmapped %s + %j is %s, as the myco-gate arm", (_f, t, cls, extra) => {
    const hcu = stream(init(), result(t, { is_error: true, ...extra }));
    const gate = gateResult(t, { is_error: true, ...extra });
    // A transient rate limit backs off in both arms (PlannerTransient here).
    expect(hcuOutcome(hcu, "", 1)).toBe(cls);
    expect(gateOutcome(gate, "", 1)).toBe(cls);
  });
  it("B2 control: an unmapped status with no wording stays a per-trial error result", () => {
    const hcu = stream(init(), result("odd", { is_error: true, api_error_status: 500 }));
    expect(hcuOutcome(hcu, "", 1)).toBe("error-result");
  });
});

/**
 * Round 3 (verifier "Parity"): BEHAVIOUR, not only regex strings. #598's `interpretResult`
 * vectors (`test/pilot/claude-transport.test.ts`: R2-D3a plain stdout, R2-D3b claimless clean
 * quota, the claim-line negatives, the 401/403/429 task-data negatives, the round-1 probes) run
 * through this arm's `readPlannerCall`. Each vector names the myco-gate arm's class; the arm
 * must reach the matching outcome. A `DONE` / `NOT DONE` claim line there is a valid parseable
 * decision here (`decisionWith`). The same table is also run through the merged
 * `interpretResult`, so the table itself cannot drift from the gate arm. Round 4: "Invalid API
 * key · Please run /login" on a claimless clean result is `auth` (#607 L1).
 */
type GateOutcome =
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
  readonly expected: GateOutcome;
}

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
  // #607 L1 (lead ruling 05:39Z): the exact CLI login phrase on a claimless clean result.
  { text: "Invalid API key · Please run /login", channel: "clean", code: 0, expected: "auth" },
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

describe("behavioural parity with the myco-gate arm's interpretResult (round 3, merged)", () => {
  it("covers every vector family the verdict names", () => {
    const channels = new Set(PARITY_VECTORS.map((v) => `${v.channel}:${v.expected}`));
    for (const c of [
      "clean:usage-limit",
      "claimed:none",
      "plain:usage-limit",
      "plain:transport-error",
      "clean:none",
      "clean:auth",
    ])
      expect(channels.has(c), c).toBe(true);
    expect(PARITY_VECTORS.length).toBeGreaterThan(90);
  });
  it.each(PARITY_VECTORS.map((v) => [v.channel, v.code, v.text, v] as const))(
    "%s exit %d %j reaches the myco-gate arm's outcome through readPlannerCall",
    (_c, _code, _t, v) => {
      expect(hcuOutcome(...hcuInput(v))).toBe(v.expected);
    },
  );
  it("the same table through the merged interpretResult (the table cannot drift)", () => {
    for (const v of PARITY_VECTORS)
      expect([v.channel, v.text, gateOutcome(...input598(v))]).toEqual([
        v.channel,
        v.text,
        v.expected,
      ]);
  });
});
