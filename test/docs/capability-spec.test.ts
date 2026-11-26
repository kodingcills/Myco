/**
 * docs/product/capability-spec.md is a pre-registration document: its bars and its statistics
 * table are what later capability packs are judged against. These tests pin the parts that
 * must not drift silently:
 *  - every capability I-M keeps each required part (what it is and is not, surface, arms,
 *    task set, primary metric, pre-registered bar, guardrails);
 *  - the McNemar critical-value table is the exact one-sided binomial tail it claims;
 *  - the pre-registration rule (§3), the measurement constraints (§4), the sequencing (§5),
 *    and the grader-independence and gate-separation rules (§1.1, §1.2) are pinned whole;
 *    every other binding paragraph (cost numerator, fixed sequence, K halt, M store rule,
 *    L-infra, L time attribution) is pinned as a whole paragraph, not by its heading.
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

/**
 * Whitespace-normalised text of FLAT from `start` up to (not including) the first `end` after it.
 * Empty when either marker is missing, so a pin never passes vacuously.
 */
function between(start: string, end: string): string {
  const i = FLAT.indexOf(start);
  if (i < 0) return "";
  const j = FLAT.indexOf(end, i + start.length);
  return j < 0 ? "" : FLAT.slice(i, j);
}

/**
 * Round-3 (verifier round 2): binding lines are pinned WHOLE, not by their bold heading, so a
 * flip of the substance underneath a heading fails. §3, §4 and §5 are pinned in full; any edit
 * to them (including an added stale-sequencing sentence) is a deliberate test change.
 */
describe("capability spec: binding paragraphs pinned whole (round 3)", () => {
  it("§3 pre-registration rule, items 1-5, is pinned in full", () => {
    expect(flat(topSection(3))).toBe(
      [
        "## 3. Pre-registration rule",
        "1. **Frozen before measurement.** Before a track's first measurement run, one commit on `main` holds its pre-registration: the bar (the track's section here, as ratified), the task set version and its manifest SHA-256, the seeds (assignment, bootstrap, task build), the step budget, the model id, and the analysis script with its SHA-256. The proposed location is `docs/product/capability-prereg/<track>-v<k>/prereg.json`; its SHA-256 over canonical JSON is the **pre-registration hash**.",
        "2. **Packs record the hash.** Every capability pack records the pre-registration hash and the commit it was frozen in. The analysis refuses a pack whose hash does not match a committed pre-registration.",
        "3. **Changes after the first run** make a new version (`v<k+1>`). Runs under the old version stay committed and are reported under it; they are never re-analysed under the new bar.",
        "4. **Experiment rows, not R1 evidence.** Capability-arm packs are experiment rows. They never count as R1 evidence unless the lead rules otherwise. Their `arm` values are not `myco-gate`, so the existing R1 path does not read them, and the R1 evidence rules (`src/benchmark/taskset-binding.ts`, `src/m2/evidence.ts`) are unchanged by this spec. `myco.benchmark.arm-row/1` allows only `myco-gate` and `hcu+shell` today, so each track adds its arm values (and the same-harness baseline arm it pairs with) as a reviewed schema change, and the check refuses those values under `--require-r1` and `--evidence`.",
        "5. **Simulated rows never count.** A row whose planner is not a model id (scripted agents, dry runs, L-infra) is never evidence for a capability bar.",
        "",
      ].join(" "),
    );
  });

  it("§4 measurement constraints are pinned in full", () => {
    expect(flat(topSection(4))).toBe(
      [
        "## 4. Measurement constraints",
        "- **The critical path comes first (Tiffany, 2026-11-26 10:46 ET).** The order is: integrity fixes, then the trial run (R1, the `hcu+shell` head-to-head, the corrections A/B on Ultra), then the 90 s demo. Capability work never delays those steps and never takes VM time from them.",
        "- **Claude Ultra only.** Every measured run uses the Claude Ultra plan: $0 Anthropic API, no Messages-API calls. Costs are token-derived estimates (§1.4).",
        "- **No runs until GO.** No measurement run starts until the integrity fixes land (#518's attempt ledger, the xlsx replacement for #503, the #494 tests-only follow-up) and the lead gives GO for that track.",
        "- **Codex is gated.** No Codex arm or Codex-run measurement without the lead's approval.",
        "- **VM work is local and single-owner,** under the VM lock (`scripts/vm-session.sh`). Linux path first wherever the capability allows (L is Linux-only at first).",
        "- **Gate guarantees are not weakened:** the gate stays bound to one trial, fails closed, keeps codes-only agent-facing reasons, and stays CSV-only for Calc until the xlsx replacement lands. Capability arms graded on fc-v1's `xlsx` documents use the grader, not the gate.",
        "- **No public leaderboard.** Results stay in the repo's evidence packs.",
        "",
      ].join(" "),
    );
  });

  it("§5 sequencing is pinned in full (no paraphrased stale sequencing can be added)", () => {
    expect(flat(topSection(5))).toBe(
      [
        "## 5. Sequencing",
        "1. **Build I-M now, in parallel.** Every capability (I-V; N-V and data capture are in the part-2 spec) is M2 scope (ruling of 2026-11-26 10:41 ET). Each track builds its tools and their separation tests and freezes its pre-registration now, alongside the other M2 tracks, without touching their files.",
        "2. **Measure only after GO,** and never ahead of the critical path or with VM time it needs (§4).",
        "3. **Each capability is its own Tier 2 track** with its own PR, a 3-round review cap, and its own pre-registration. A track that hits the cap stops and goes back to the lead.",
        "4. **Dependencies:** every track's measurement needs its baseline arm (C1 or `hcu+shell`) ported to the Ultra (Claude Code) harness (§1.3). The capability tracks reuse the Ultra `hcu+shell` harness the trial run's head-to-head needs, and do not build a second one. C1 has no Ultra harness, so I's primary arm (`C1+I` vs `C1`) cannot be measured until C1 is ported onto that same harness; the port never takes VM time from the trial run. K needs the multi-step instruction renderer and grader entry; L needs the disposable Linux desktop and L-infra's zero-contamination result; M's measurement uses the best shown base surface, so it is measured after I's (and J's, if shown). These order measurement, not building.",
        "",
      ].join(" "),
    );
  });

  it("§1.1 grader independence and the verified-task definition are pinned in full", () => {
    expect(between("### 1.1 ", "### 1.2 ")).toBe(
      [
        "### 1.1 The grader decides; the gate does not",
        "- **The primary metric of every track is graded by the independent grader** (`src/benchmark/grade/`, `false-completion-grader/1` or its successor entry for a new family). The grader shares no code with the gate (import-graph test), reads only the captured persisted bytes against the pinned pristine fixture and intent, and never sees a claim or a verdict (`docs/benchmark/public/grading-protocol.md` §§1-4).",
        "- **The gate's verdict is never the measurement.** Where a capability uses the gate at runtime (K's corrections, M's store rule), the gate is part of the treatment, and the grader still grades the outcome.",
        "- **A verified task** in this spec is R7's success (`src/m2/evidence.ts`: `row.accepted && grade.status === \"pass\"`) applied to capability rows: the row is accepted and the grader graded the captured document `pass`. Today `expectedAccepted` (`src/benchmark/check.ts`) keys on the arm name, not on gate use: only `hcu+shell` is accepted on a done claim alone, and every other arm needs a gate `verified`. A gate-less capability row such as `C1+I` would therefore read as not accepted under today's code, so the schema change in §3 item 4 must also extend `expectedAccepted` so that gate-less capability arms are accepted on a done claim alone. The two cases it must then implement:",
        "- **Gate-less rows** (the §1.3 default, as in `hcu+shell`): accepted means the agent claimed done, so a verified task is a done claim that the grader graded `pass`.",
        "- **Gated rows** (both arms of K, M's learn phase, and any gate-present variant): accepted means the agent claimed done **and** the gate's verdict was `verified`, so a verified task is a done claim the gate verified and the grader graded `pass`. A grader `pass` that the gate refuted or left uncertain is not verified; it is reported as \"correct, not accepted\". The gate can only withhold a verified task, never grant one the grader did not pass.",
        'A `pass` without a done claim is "correct, not claimed" and is not verified. `ungradable` is never verified.',
        "- **Per-trial persisted-bytes capture** is the harness's, after the agent stops, exactly as for the existing arms (grading protocol §2). No capability tool runs or sees the capture.",
        "",
      ].join(" "),
    );
  });

  it("§1.2 gate separation is pinned in full", () => {
    expect(between("### 1.2 ", "### 1.3 ")).toBe(
      [
        "### 1.2 Capability tools stay separate from the gate",
        "Every capability ships its agent-facing tools in a server that is not `myco-gate` (proposed name: `myco-cap`, served to Claude Code as `mcp__myco-cap__<tool>`). These rules hold for every tool in this spec, and each track's tests must pin them:",
        "1. **The gate request is unchanged.** `myco.gate/v1` still takes only `taskId`, `runId` and `claim`. No capability adds a request field. Any future gate input needs its own explicitly scoped, reviewed change, as #514's corrections did. A track test asserts that `ORACLE_INPUT_FIELDS` and the request schema in `src/gate/api.ts` are byte-unchanged by the track.",
        "2. **No oracle internals reach the agent.** A capability tool never returns expected values, the pristine fixture (its bytes, values or digest), the sealed digest, oracle source or spec beyond the instruction's fields, the task metadata fields the task-set card marks \"not shown\", host paths, or secrets. It reads only what the agent could already reach in the guest: the live app and the files under the session's guest read root.",
        "3. **The gate's verdict cannot be influenced by a capability tool.** No capability tool writes to the evidence root, the sealed vault, the registry or the audit log. Each tool is classified in `src/integrity/surface.ts` (reach `guest` or `agent-local`, never a host-write reach), and the TIF-266 isolation test (R4) must still pass with the tool added. A track test runs the gate over the same captured bytes with and without the capability server attached and asserts identical results.",
        "4. **Import boundary.** Capability modules import nothing from `src/gate/` oracle, registry, sealed or corrections code, `src/benchmark/grade/`, `src/tasks/intent.ts` (`groundTruth`), the fixture generator, or any manifest; a test enforces it the way `test/baseline/hcu-shell/import-boundary.test.ts` does.",
        "5. **Agent-facing errors carry codes only**, as the gate's do.",
        "",
      ].join(" "),
    );
  });

  it.each([
    [
      "R7 cost numerator (§1.4)",
      "| Cost per verified task",
      "| False done",
      "| Cost per verified task | token-derived cost ESTIMATE over ALL trials (failed, refuted and superseded attempts included) / verified tasks | Secondary, R7's rule | ",
    ],
    [
      "fixed-sequence family-wise rule (§1.5)",
      "- **Several bar components",
      '- **"Not shown"',
      "- **Several bar components are tested in a fixed sequence** at alpha 0.05 each: a later component is tested only if every earlier one is shown. This keeps the family-wise error at 0.05 per track. Tracks are not pooled. ",
    ],
    [
      "K halts on the first gate miss",
      "- **Any gate miss halts",
      "- **K's contrast",
      "- **Any gate miss halts the K run.** A gate miss is a `verified` verdict on an attempt the grader grades `fail` or `ungradable`. On the first one, the harness stops the batch, the pack is reported as halted with that trial, and the track goes back to the lead. ",
    ],
    [
      "M store rule",
      "**Store rule.**",
      "**Arms.** Skills-on",
      "**Store rule.** The harness stores a skill only when the trial's gate verdict was `verified` and accepted, after the capture. `refuted` and `uncertain` runs are never stored. The store is append-only, and each skill keeps its source `trialKey` and gate verdict host-side, never shown to the agent. ",
    ],
    [
      "L-infra quantity",
      "1. **L-infra",
      "2. **L-agent",
      "1. **L-infra (no model, not agent evidence).** The Linux path's deterministic scripted agent runs fc-v1's satisfiable tasks at N = 1, 2, 4 and 8, with a unique canary value seeded into each desktop. Must show 0 contamination events over at least 200 trials before any model run. These rows are simulated and never count as evidence of agent capability. ",
    ],
    [
      "L per-trial time attribution",
      "**Per-trial time attribution:**",
      "**Guardrails.** Contamination",
      "**Per-trial time attribution:** each trial is attributed its desktop-occupancy time (start, reset, run, capture and teardown) divided by N, and batch wall-clock that no trial occupies (stragglers at a batch's end) is spread over that batch's trials in proportion to their attributed time, so the attributed times sum to the batch wall-clock. A resample's throughput is its verified tasks divided by the sum of its attributed times. ",
    ],
    [
      "expectedAccepted attribution",
      "Today `expectedAccepted`",
      "- **Gate-less rows**",
      "Today `expectedAccepted` (`src/benchmark/check.ts`) keys on the arm name, not on gate use: only `hcu+shell` is accepted on a done claim alone, and every other arm needs a gate `verified`. A gate-less capability row such as `C1+I` would therefore read as not accepted under today's code, so the schema change in §3 item 4 must also extend `expectedAccepted` so that gate-less capability arms are accepted on a done claim alone. The two cases it must then implement: ",
    ],
  ])("pins the %s paragraph whole", (_name, start, end, whole) => {
    expect(between(start, end)).toBe(whole);
  });

  it("the expectedAccepted claim is true of today's check: a gate-less non-hcu+shell arm is not accepted", () => {
    const row = (fields: object) => fields as unknown as BenchmarkArmRow;
    expect(expectedAccepted(row({ arm: "C1+I", claim: "done" }))).toBe(false);
    expect(
      expectedAccepted(row({ arm: "C1+I", claim: "done", gate: { called: false, verdict: null } })),
    ).toBe(false);
    expect(expectedAccepted(row({ arm: "hcu+shell", claim: "done" }))).toBe(true);
  });
});
