/**
 * docs/product/capability-spec.md is a pre-registration document: its bars and its statistics
 * table are what later capability packs are judged against. These tests pin the parts that
 * must not drift silently:
 *  - every capability I-M keeps each required part (what it is and is not, surface, arms,
 *    task set, primary metric, pre-registered bar, guardrails);
 *  - the McNemar critical-value table is the exact one-sided binomial tail it claims;
 *  - the pre-registration rule and the measurement constraints keep their binding lines.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BenchmarkArmRow, expectedAccepted } from "../../src/benchmark/check.ts";

const ROOT = join(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const DOC = read("docs/product/capability-spec.md");
/** The doc with every run of whitespace collapsed to one space, so pins survive re-wrapping. */
const FLAT = DOC.replace(/\s+/g, " ");
const flat = (text: string) => text.replace(/\s+/g, " ");

const CAPABILITIES = ["I", "J", "K", "L", "M"] as const;

const REQUIRED_PARTS = [
  "**What it is.**",
  "**What it is not.**",
  "**Agent-facing surface",
  "**Arms.**",
  "**Task set",
  "**Primary metric",
  "**Pre-registered bar",
  "**Guardrails.**",
] as const;

/** The text of capability `id`'s section: from its `### X.` heading to the next heading of level 2 or 3. */
function section(id: string): string {
  const start = DOC.indexOf(`\n### ${id}. `);
  if (start < 0) return "";
  const rest = DOC.slice(start + 1);
  const next = rest.slice(4).search(/\n#{2,3} /);
  return next < 0 ? rest : rest.slice(0, next + 4);
}

/** The text of top-level section `n` (`## n. `) up to the next `## ` heading. */
function topSection(n: number): string {
  const start = DOC.indexOf(`\n## ${n}. `);
  if (start < 0) return "";
  const rest = DOC.slice(start + 1);
  const next = rest.slice(3).search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next + 3);
}

/** P(X >= b) for X ~ Binomial(d, 1/2). */
function upperTail(b: number, d: number): number {
  let choose = 1;
  let sum = 0;
  for (let k = 0; k <= d; k++) {
    if (k > 0) choose = (choose * (d - k + 1)) / k;
    if (k >= b) sum += choose;
  }
  return sum / 2 ** d;
}

describe("capability spec: structure", () => {
  for (const id of CAPABILITIES) {
    it(`capability ${id} has every required part`, () => {
      const text = section(id);
      expect(text, `section ### ${id}. missing`).not.toBe("");
      for (const part of REQUIRED_PARTS) expect(text, `${id}: ${part}`).toContain(part);
    });

    it(`capability ${id}'s bar names a test or a threshold and alpha-level rule`, () => {
      const bar = section(id).slice(section(id).indexOf("**Pre-registered bar"));
      expect(bar).toMatch(/McNemar|bootstrap|non-inferior/);
    });
  }

  it("M never stores refuted or uncertain runs", () => {
    expect(section("M")).toContain("`refuted` and `uncertain` runs are never stored");
  });

  it("K keeps every attempt in the attempt ledger", () => {
    expect(section("K")).toContain("stays in #518's attempt ledger");
  });

  it("J logs the route of every action", () => {
    expect(section("J")).toContain("Every action has a route record");
  });

  it("L fails on a single contamination event", () => {
    expect(section("L")).toContain("Zero contamination events");
  });
});

describe("capability spec: statistics table", () => {
  const rows = [...DOC.matchAll(/^ {2}\| (\d+) \| (none|\d+) \| (-|0\.\d{4}) \|$/gm)];

  it("has the table", () => {
    expect(rows.length).toBeGreaterThanOrEqual(6);
  });

  it("each row is the smallest count with one-sided exact p <= 0.05, and that p", () => {
    for (const [, dText, bText, pText] of rows) {
      const d = Number(dText);
      let smallest: number | null = null;
      for (let b = 0; b <= d; b++)
        if (upperTail(b, d) <= 0.05) {
          smallest = b;
          break;
        }
      if (bText === "none") {
        expect(smallest, `d=${d}`).toBeNull();
        expect(pText).toBe("-");
      } else {
        expect(Number(bText), `d=${d}`).toBe(smallest);
        expect(pText, `d=${d}`).toBe(upperTail(Number(bText), d).toFixed(4));
      }
    }
  });

  it("states the minimum of 5 discordant tasks the table implies", () => {
    expect(DOC).toContain("fewer than 5 discordant tasks");
    expect(upperTail(4, 4)).toBeGreaterThan(0.05);
    expect(upperTail(5, 5)).toBeLessThanOrEqual(0.05);
  });
});

describe("capability spec: binding lines", () => {
  it.each([
    "They never\n   count as R1 evidence unless the lead rules otherwise.",
    "**Packs record the hash.**",
    "`myco.gate/v1` still takes only `taskId`, `runId` and\n   `claim`.",
    "**The gate's verdict cannot be influenced by a capability tool.**",
    "never billed USD",
    "never 0",
    "**Claude Ultra only.**",
    "**Codex is gated.**",
    "**No runs until GO.**",
    "3-round review cap",
    "**No public leaderboard.**",
  ])("keeps %j", (line) => {
    expect(DOC).toContain(line);
  });

  it("claims no result and quotes no price beyond $0", () => {
    expect(DOC).toContain("no result is claimed");
    expect(DOC.match(/\$\d[\d.,]*/g) ?? []).toEqual(["$0", "$0"]);
  });
});

/** Smallest count b with one-sided exact p <= 0.05 at d discordant tasks, or null. */
function critical(d: number): number | null {
  for (let b = 0; b <= d; b++) if (upperTail(b, d) <= 0.05) return b;
  return null;
}

function choose(n: number, k: number): number {
  let c = 1;
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
  return c;
}

/** Power of the exact one-sided McNemar bar (alpha 0.05, at least 5 discordant) at n tasks. */
function power(n: number, p10: number, p01: number): number {
  let total = 0;
  const share = p10 / (p10 + p01);
  for (let d = 5; d <= n; d++) {
    const b = critical(d);
    if (b === null) continue;
    const pd = choose(n, d) * (p10 + p01) ** d * (1 - p10 - p01) ** (n - d);
    let win = 0;
    for (let k = b; k <= d; k++) win += choose(d, k) * share ** k * (1 - share) ** (d - k);
    total += pd * win;
  }
  return total;
}

describe("capability spec: round-2 fixes", () => {
  it("sequencing: I-M are built now in parallel; no stale 'first' or 'after A-H' wording", () => {
    expect(DOC).not.toMatch(/I first|\(first\)|after the in-flight M2 tracks/);
    expect(topSection(5)).toContain("**Build I-M now, in parallel.**");
    expect(flat(topSection(5))).toContain(
      "**Measure only after GO,** and never ahead of the critical path or with VM time it needs",
    );
  });

  it("states the 10:46 critical-path priority lock in the measurement constraints", () => {
    const s4 = flat(topSection(4));
    expect(s4).toContain("**The critical path comes first (Tiffany, 2026-11-26 10:46 ET).**");
    expect(s4).toContain(
      "integrity fixes, then the trial run (R1, the `hcu+shell` head-to-head, the corrections A/B on Ultra), then the 90 s demo",
    );
    expect(s4).toContain("never delays those steps and never takes VM time from them");
  });

  it("L's throughput bar is a bootstrap lower bound >= 2.8, never a point estimate", () => {
    const L = flat(section("L"));
    const bar = L.slice(L.indexOf("**Pre-registered bar"), L.indexOf("**Guardrails"));
    expect(bar).toContain(
      "the one-sided 95% lower bound of throughput(N = 4) / throughput(N = 1) is at least 2.8 (scaling efficiency 0.7)",
    );
    expect(bar).toContain("10,000 resamples, with a pre-registered seed");
    expect(bar).toContain("the point estimate alone never meets the bar");
    expect(bar).not.toMatch(/≥ 2\.8 ×/);
    expect(2.8 / 4).toBeCloseTo(0.7, 10);
  });

  it("'verified' is R7's success, and gated rows also need a gate `verified`", () => {
    expect(FLAT).toContain('`row.accepted && grade.status === "pass"`');
    expect(FLAT).toContain(
      "accepted means the agent claimed done **and** the gate's verdict was `verified`",
    );
    expect(read("src/m2/evidence.ts")).toContain('row.accepted && grade?.status === "pass"');
    // The doc's two cases are what the check enforces.
    const row = (fields: object) => fields as unknown as BenchmarkArmRow;
    expect(expectedAccepted(row({ arm: "hcu+shell", claim: "done" }))).toBe(true);
    expect(
      expectedAccepted(
        row({ arm: "myco-gate", claim: "done", gate: { called: true, verdict: "refuted" } }),
      ),
    ).toBe(false);
    expect(
      expectedAccepted(
        row({ arm: "myco-gate", claim: "done", gate: { called: true, verdict: "verified" } }),
      ),
    ).toBe(true);
  });

  it("K adopts the corrections A/B safeguards and is never a corrections result", () => {
    const K = flat(section("K"));
    expect(K).toContain("**Any gate miss halts the K run.**");
    expect(K).toContain(
      "Stage 0: 30 paired trials, plumbing only; Stage 1: fc-v1, 100 paired trials per arm, exact sign test",
    );
    expect(K).toContain("does not re-measure the corrections effect");
    expect(K).toContain("A K result is never reported as a corrections result");
  });

  it("names the missing Ultra harness for the baseline arms as a dependency", () => {
    expect(FLAT).toContain("**Prerequisite: an Ultra harness for the baseline arms.**");
    const s5 = flat(topSection(5));
    expect(s5).toContain("ported to the Ultra (Claude Code) harness");
    expect(s5).toContain("C1 has no Ultra harness");
  });

  it("alpha is 0.05 everywhere it is stated", () => {
    const alphas = [...DOC.matchAll(/alpha\s+(?:is\s+)?(\d+(?:\.\d+)?)/gi)].map((m) => m[1]);
    expect(alphas.length).toBeGreaterThanOrEqual(3);
    for (const a of alphas) expect(a).toBe("0.05");
    expect(FLAT).toContain("**Alpha is 0.05, one-sided, for every bar component in this spec.**");
  });

  it("every McNemar test is one-sided", () => {
    const before = [...DOC.matchAll(/(\S+)\s+McNemar/g)].map((m) => m[1]);
    expect(before.length).toBeGreaterThanOrEqual(5);
    for (const word of before) expect(word).toBe("one-sided");
  });

  it.each([
    ["I", "**Primary metric.** Verified rate on the 90 satisfiable tasks, by the grader."],
    [
      "J",
      "**Primary metric (co-primary).** Wall time per verified task and steps per verified task.",
    ],
    [
      "K",
      "**Primary metric.** Verified rate (completion) on the 40 tasks, by the grader on the final captured document.",
    ],
    [
      "L",
      "**Primary metric.** Throughput: verified tasks per wall-clock hour over the whole batch, including desktop start, reset and teardown.",
    ],
    ["M", "**Primary metric.** Verified rate on the 40 test tasks, by the grader."],
  ])("capability %s pins its primary metric", (id, line) => {
    const text = flat(section(id));
    expect(text).toContain(line);
    expect(text).not.toMatch(/by the gate\b/);
  });

  it("pins each track's n", () => {
    expect(flat(section("I"))).toContain("all 100 tasks, k = 1 run per task per arm");
    expect(flat(section("J"))).toContain("fc-v1 satisfiable tasks (90), k = 1");
    expect(flat(section("K"))).toContain("40 long multi-step Calc tasks");
    expect(flat(section("L"))).toContain("fc-v1's 90 satisfiable tasks");
    const M = flat(section("M"));
    expect(M).toContain("learn split: 20 tasks");
    expect(M).toContain("test split: 20 **repeat** tasks");
    expect(M).toContain("and 20 **similar** tasks");
  });

  it("R1: capability packs are never R1 evidence, and the paragraph is pinned whole", () => {
    for (const m of FLAT.matchAll(/counts? as R1 evidence/g))
      expect(FLAT.slice(Math.max(0, (m.index ?? 0) - 6), m.index)).toBe("never ");
    const s3 = flat(topSection(3));
    const para = s3.slice(s3.indexOf("4. **Experiment rows"), s3.indexOf("5. **Simulated"));
    expect(para).toBe(
      "4. **Experiment rows, not R1 evidence.** Capability-arm packs are experiment rows. They never count as R1 evidence unless the lead rules otherwise. Their `arm` values are not `myco-gate`, so the existing R1 path does not read them, and the R1 evidence rules (`src/benchmark/taskset-binding.ts`, `src/m2/evidence.ts`) are unchanged by this spec. `myco.benchmark.arm-row/1` allows only `myco-gate` and `hcu+shell` today, so each track adds its arm values (and the same-harness baseline arm it pairs with) as a reviewed schema change, and the check refuses those values under `--require-r1` and `--evidence`. ",
    );
  });

  it("the power table is the exact power of the bar", () => {
    const rows = [...DOC.matchAll(/^ {2}\| (\d+) \| (0\.\d\d) \/ (0\.\d\d) \| (0\.\d\d) \|$/gm)];
    expect(rows.length).toBe(7);
    for (const [, n, p10, p01, stated] of rows)
      expect(power(Number(n), Number(p10), Number(p01)).toFixed(2), `n=${n} ${p10}/${p01}`).toBe(
        stated,
      );
  });

  it("J's margin caveat is the computed bound, and it exceeds the margin", () => {
    const bound = 1.645 * Math.sqrt(0.1 / 90) * 100;
    expect(bound.toFixed(1)).toBe("5.5");
    expect(bound).toBeGreaterThan(5);
    expect(FLAT).toContain("1.645 × √(0.10 / 90) ≈ 5.5 points, above the 5-point margin");
  });

  it("explains 5 (one-sided) vs R2's 6 (two-sided) discordant", () => {
    expect(flat(read("docs/m2-scorecard.md"))).toContain("underpowered below 6 discordant pairs");
    const twoSided = (d: number) => Math.min(1, 2 * upperTail(d, d));
    expect(twoSided(5)).toBeGreaterThan(0.05);
    expect(twoSided(6)).toBeLessThanOrEqual(0.05);
    expect(twoSided(5).toFixed(4)).toBe("0.0625");
    expect(FLAT).toContain("at d = 5 the best two-sided p is 0.0625");
    expect(FLAT).toContain("The two thresholds are consistent, not in conflict.");
  });

  it("M calls the gate in the learn phase only", () => {
    const M = flat(section("M"));
    expect(M).toContain("The learn phase calls the gate at the end of each trial");
    expect(M).toContain("In the test phase neither arm calls the gate");
  });
});

describe("capability spec: repo facts it cites", () => {
  it("every cited repo path exists", () => {
    const paths = [...DOC.matchAll(/`((?:src|docs|test|benchmark|scripts)\/[^`<>]*)`/g)].map(
      (m) => m[1] ?? "",
    );
    expect(paths.length).toBeGreaterThanOrEqual(15);
    for (const p of paths) expect(existsSync(join(ROOT, p)), p).toBe(true);
  });

  it("C1's vocabulary is click/type_text/press_key in src/baseline/c1.ts, step budget 30", () => {
    const c1 = read("src/baseline/c1.ts");
    for (const tool of ['"click"', '"type_text"', '"press_key"']) expect(c1).toContain(tool);
    expect(read("src/baseline/c1-trial.ts")).toMatch(/export const STEP_BUDGET = 30;/);
    expect(FLAT).toContain("step budget 30 (C1's)");
  });

  it("arm-row/1 allows only myco-gate and hcu+shell", () => {
    expect(read("src/benchmark/check.ts")).toContain(
      'export type Arm = "myco-gate" | "hcu+shell";',
    );
  });

  it("fc-v1 has 100 tasks: 90 satisfiable, 10 invalid-target", () => {
    const tasks = read("benchmark/false-completion/fc-v1/tasks.jsonl")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { satisfiable: boolean; faultClass: string });
    expect(tasks.length).toBe(100);
    expect(tasks.filter((t) => t.satisfiable).length).toBe(90);
    expect(tasks.filter((t) => t.faultClass === "invalid-target").length).toBe(10);
  });
});
