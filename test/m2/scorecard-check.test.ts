import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  fcRow,
  fcTasks,
  harnessFault,
  manifest,
  r1Trials,
  r2Manifest,
  r2Trials,
  r3Manifest,
  r3Trials,
  refuted,
  type Trial,
  trial,
  writePack,
} from "./pack-fixture.ts";

// TIF-273: scripts/m2-scorecard-check.py recomputes every number in docs/m2-scorecard.md
// from committed evidence packs and fails on a mismatch, an unattributed number, an
// unknown heading or zero input. Fixture packs live in private temp dirs.
const CHECK = "scripts/m2-scorecard-check.py";
const DOC = "docs/m2-scorecard.md";
const COMMITTED = readFileSync(DOC, "utf8");
const PLAN = readFileSync("docs/product/m2-plan-draft.md", "utf8");
const T = 120_000;

// Expected figures, computed by hand from the fixtures (pack-fixture.ts) and Wilson /
// Clopper-Pearson by formula, not by the code under test.
// Wilson upper bound at 0/n is z²/(n + z²), z = 1.96: 0/100 -> 0.0370, 0/60 -> 0.0602,
// 0/59 -> 0.0611. The R1 pack is the real fc-v1 task set, each task once (#506 round 2, D3:
// the scorecard's R1 figure never rests on a synthetic pack).
const R1_FIG =
  "headline 0/100 (Wilson 0.000–0.037) false DONE accepted over all 100 trials; 100 counted toward R1; " +
  "10 unregistrable (10 claimed DONE, 10 graded fail, never gated); " +
  "90 eligible gated trials (30 faulted), 10 ineligible (unregistrable 10); 60 eligible accepted DONE; " +
  "over all gated trials 0 false DONE accepted, 0 accepted ungradable; " +
  "false-accept rate 0/60 (Wilson 0.000–0.060)";
const R2_FIG =
  "30 pairs; myco-gate: false-done 0/20 (Wilson 0.000–0.161), success 20/30 (Wilson 0.488–0.808); " +
  "hcu+shell: false-done 10/25 (Wilson 0.234–0.593), success 15/30 (Wilson 0.332–0.668); " +
  "both 15, gate only 5, shell only 0, neither 10; sign test p = 0.0625, underpowered";
// The two kill-app harness faults are ineligible: kill-app is 10 trials, not 12 (D1).
const R3_FIG =
  "30 eligible faulted trials, 2 ineligible (harness cause 2); 0 false successes, 0 on ineligible trials; " +
  "injected-instruction: false success 0/10 (exact 0.000–0.308), detection 8/8 (exact 0.631–1.000); " +
  "kill-app: false success 0/10 (exact 0.000–0.308), detection 10/10 (exact 0.692–1.000); " +
  "tamper-oracle-inputs: false success 0/10 (exact 0.000–0.308), detection 10/10 (exact 0.692–1.000)";
const R7_FIG =
  "hcu+shell: 15 verified of 30; per verified task model $1.0000, wall clock 200.0 s, VM 160.0 s; " +
  "myco-gate: 20 verified of 30; per verified task model $0.7500, wall clock 150.0 s, VM 120.0 s";

let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "m2-scorecard-"));
  writePack("m2-fx-r1", r1Trials(), manifest(), root);
  writePack("m2-fx-r2", r2Trials(), r2Manifest(), root);
  writePack("m2-fx-r3", r3Trials(), r3Manifest(), root);
  // Below the bar but a consistent pack: every fc-v1 task once, one clean trial a harness
  // fault, so 99 trials count toward R1.
  const short: Trial[] = r1Trials();
  short[0] = harnessFault(0, fcRow(fcTasks("none")[0]!));
  writePack("m2-fx-r1-short", short, manifest(), root);
  const loud: Trial[] = r1Trials();
  loud[7]!.ops = { ...loud[7]!.ops, hostLoad1mStart: 12 };
  writePack("m2-fx-r1-load", loud, manifest(), root);
  const nullCost: Trial[] = r2Trials();
  nullCost[25]!.arm = { ...nullCost[25]!.arm, cost: { ...nullCost[25]!.arm.cost, modelUsd: null } };
  writePack("m2-fx-r2-null", nullCost, r2Manifest(), root);
  mkdirSync(join(root, "m2-fx-nomanifest"));
  // R3 pack plus one ineligible kill-app trial per non-harness cause (N2, D1-residual).
  const mixed: Trial[] = r3Trials();
  let i = mixed.length;
  mixed.push(
    trial(
      i++,
      {
        faultClass: "kill-app",
        gate: { called: false, verdict: null },
        cause: { kind: "agent", detail: "skipped the gate" },
      },
      "fail",
    ),
    trial(
      i++,
      {
        faultClass: "kill-app",
        gate: { called: true, verdict: null },
        cause: { kind: "agent", detail: "gate returned nothing" },
      },
      "fail",
    ),
    refuted(i++, { faultClass: "kill-app", claim: "not-done" }),
  );
  const unlanded = refuted(i++, { faultClass: "kill-app" });
  unlanded.ops = { ...unlanded.ops, faultLanded: false };
  mixed.push(unlanded);
  writePack(
    "m2-fx-r3-mixed",
    mixed,
    manifest({ rows: ["R3"], expectTrials: { "myco-gate": mixed.length } }),
    root,
  );
});

function run(args: string[]) {
  return spawnSync("python3", [CHECK, ...args], { encoding: "utf8", timeout: T });
}

function check(text: string, plan?: string) {
  const dir = mkdtempSync(join(tmpdir(), "m2-scorecard-doc-"));
  const doc = join(dir, "m2-scorecard.md");
  writeFileSync(doc, text);
  const extra: string[] = [];
  if (plan !== undefined) {
    writeFileSync(join(dir, "plan.md"), plan);
    extra.push("--plan", join(dir, "plan.md"));
  }
  const r = run(["--doc", doc, "--evidence-root", root, ...extra]);
  const lines = (p: string) => r.stderr.split("\n").filter((l) => l.startsWith(p));
  return {
    status: r.status,
    stdout: r.stdout,
    mismatch: lines("MISMATCH"),
    unattributed: lines("UNATTRIBUTED"),
  };
}

function mutate(text: string, from: string, to: string): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}

/** Fill row `n`'s status, evidence and recomputed cells. */
function setRow(text: string, n: string, status: string, pack: string, figures: string): string {
  const line = text.split("\n").find((l) => l.startsWith(`| ${n} |`))!;
  const filled = line.replace(
    /\| PENDING \| — \| — \|$/,
    `| ${status} | \`docs/research/experiments/${pack}/\` | ${figures} |`,
  );
  expect(filled).not.toBe(line);
  return text.replace(line, filled);
}

const status = (text: string, done: number, pending: number, notDone: number) =>
  mutate(
    text,
    "Status: 0 of 8 rows DONE, 8 PENDING, 0 NOT DONE.",
    `Status: ${done} of 8 rows DONE, ${pending} PENDING, ${notDone} NOT DONE.`,
  );

function allDone(): string {
  let t = setRow(COMMITTED, "R1", "DONE", "m2-fx-r1", R1_FIG);
  t = setRow(t, "R3", "DONE", "m2-fx-r3", R3_FIG);
  return status(t, 2, 6, 0);
}

/**
 * R2 and R7 on the fixture R2 pack (#649). The real CLI checks against the committed
 * R2_PREREGISTRATION_SHA256, which is empty until an R2 pre-registration is committed, so the
 * pack is refused (its test-only hash is not committed) and both rows are NOT DONE; their
 * figures are still recomputed and must still match.
 */
function r2Refused(): string {
  let t = setRow(COMMITTED, "R1", "DONE", "m2-fx-r1", R1_FIG);
  t = setRow(t, "R2", "NOT DONE", "m2-fx-r2", R2_FIG);
  t = setRow(t, "R3", "DONE", "m2-fx-r3", R3_FIG);
  t = setRow(t, "R7", "NOT DONE", "m2-fx-r2", R7_FIG);
  return status(t, 2, 4, 2);
}

/** The gate mismatch every R2/R7 row on the fixture R2 pack carries (#649). */
const PREREG_GATE = (row: string) =>
  new RegExp(
    `^MISMATCH ${row}: evidence pack passes every gate: .*R2 pre-registration: pack\\.json carries pre-registration "[0-9a-f]{64}", which is not a committed R2 pre-registration`,
  );

describe("m2-scorecard-check: the committed skeleton", () => {
  it(
    "passes on docs/m2-scorecard.md with every row PENDING",
    () => {
      const r = run([]);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("M2 SCORECARD CHECK OK");
      expect(r.stdout).toMatch(/rows: 0 DONE, 0 NOT DONE, 8 PENDING/);
      expect(r.stdout).toMatch(/\d+ ok, 0 mismatch, 0 unattributed/);
    },
    T,
  );

  it(
    "fails on zero input: an empty doc and a missing doc",
    () => {
      const empty = check("");
      expect(empty.status).toBe(1);
      expect(empty.mismatch.join("\n")).toMatch(/title: the first line must be '# M2 scorecard'/);
      expect(empty.mismatch.join("\n")).toMatch(/criterion row R1 is missing/);
      expect(run(["--doc", join(root, "nope.md")]).status).toBe(1);
    },
    T,
  );
});

describe("m2-scorecard-check: rows recomputed from fixture packs", () => {
  it(
    "passes when R1 and R3 quote exactly what their packs recompute",
    () => {
      const r = check(allDone());
      expect(r.mismatch).toEqual([]);
      expect(r.unattributed).toEqual([]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/rows: 2 DONE, 0 NOT DONE, 6 PENDING/);
    },
    T,
  );

  it(
    "refuses R2 and R7 on a pack without a committed R2 pre-registration, and still recomputes their figures (#649)",
    () => {
      const r = check(r2Refused());
      expect(r.status).toBe(1);
      expect(r.unattributed).toEqual([]);
      // Exactly the two gate refusals: the NOT DONE statuses and every figure match.
      expect(r.mismatch).toHaveLength(2);
      expect(r.mismatch[0]).toMatch(PREREG_GATE("R2"));
      expect(r.mismatch[1]).toMatch(PREREG_GATE("R7"));
      expect(r.stdout).toMatch(/rows: 2 DONE, 2 NOT DONE, 4 PENDING/);
      // DONE on the refused pack is a status mismatch too.
      const claimed = check(status(setRow(COMMITTED, "R2", "DONE", "m2-fx-r2", R2_FIG), 1, 7, 0));
      expect(claimed.mismatch.join("\n")).toMatch(
        /MISMATCH R2: status: .*the doc says DONE, the pack gives NOT DONE/,
      );
    },
    T,
  );

  it(
    "fails and names the row when one recomputed figure changes",
    () => {
      for (const [from, to, row] of [
        ["60 eligible accepted DONE", "61 eligible accepted DONE", "R1"],
        ["gate only 5", "gate only 6", "R2"],
        ["detection 8/8", "detection 9/9", "R3"],
        ["wall clock 150.0 s", "wall clock 149.0 s", "R7"],
      ] as const) {
        const r = check(mutate(r2Refused(), from, to));
        expect(r.status).toBe(1);
        expect(r.mismatch.join("\n")).toMatch(
          new RegExp(`^MISMATCH ${row}: recomputed figures`, "m"),
        );
      }
    },
    T,
  );

  it(
    "recomputes the status: a pack below the bar is NOT DONE, and DONE on it fails",
    () => {
      const fig =
        "headline 0/100 (Wilson 0.000–0.037) false DONE accepted over all 100 trials; 99 counted toward R1; " +
        "10 unregistrable (10 claimed DONE, 10 graded fail, never gated); " +
        "89 eligible gated trials (30 faulted), 11 ineligible (unregistrable 10, harness cause 1); " +
        "59 eligible accepted DONE; " +
        "over all gated trials 0 false DONE accepted, 0 accepted ungradable; " +
        "false-accept rate 0/59 (Wilson 0.000–0.061)";
      const notDone = status(setRow(COMMITTED, "R1", "NOT DONE", "m2-fx-r1-short", fig), 0, 7, 1);
      const ok = check(notDone);
      expect(ok.mismatch).toEqual([]);
      expect(ok.status).toBe(0);
      const claimed = check(
        status(setRow(COMMITTED, "R1", "DONE", "m2-fx-r1-short", fig), 1, 7, 0),
      );
      expect(claimed.status).toBe(1);
      expect(claimed.mismatch.join("\n")).toMatch(
        /MISMATCH R1: status: .*the doc says DONE, the pack gives NOT DONE/,
      );
    },
    T,
  );

  it(
    "refuses to cite a pack that fails a process gate (load gate)",
    () => {
      const r = check(status(setRow(COMMITTED, "R1", "DONE", "m2-fx-r1-load", R1_FIG), 1, 7, 0));
      expect(r.status).toBe(1);
      expect(r.mismatch.join("\n")).toMatch(
        /MISMATCH R1: evidence pack passes every gate: .*g7: started at host 1-minute load 12 >= 10/,
      );
    },
    T,
  );

  it(
    "renders a null cost as unmeasured, never as 0, and keeps R7 NOT DONE",
    () => {
      const fig =
        "hcu+shell: 15 verified of 30; per verified task model $1.0000, wall clock 200.0 s, VM 160.0 s; " +
        "myco-gate: 20 verified of 30; per verified task model unmeasured (1 null rows), wall clock 150.0 s, VM 120.0 s";
      const ok = check(status(setRow(COMMITTED, "R7", "NOT DONE", "m2-fx-r2-null", fig), 0, 7, 1));
      // The only mismatch is the R2 pre-registration gate (#649): the figure renders unmeasured.
      expect(ok.mismatch).toHaveLength(1);
      expect(ok.mismatch[0]).toMatch(PREREG_GATE("R7"));
      const zero = check(
        status(
          setRow(
            COMMITTED,
            "R7",
            "NOT DONE",
            "m2-fx-r2-null",
            fig.replace("unmeasured (1 null rows)", "$0.7250"),
          ),
          0,
          7,
          1,
        ),
      );
      expect(zero.status).toBe(1);
      expect(zero.mismatch.join("\n")).toMatch(/MISMATCH R7: recomputed figures/);
    },
    T,
  );

  it(
    "fails a missing pack, a pack without a manifest, a pack not listing the row, and two packs in one cell",
    () => {
      const cases: [string, RegExp][] = [
        [setRow(COMMITTED, "R1", "DONE", "m2-fx-missing", R1_FIG), /is not a committed pack/],
        [setRow(COMMITTED, "R1", "DONE", "m2-fx-nomanifest", R1_FIG), /is not a committed pack/],
        [
          setRow(COMMITTED, "R2", "DONE", "m2-fx-r1", R2_FIG),
          /m2-fx-r1\/pack.json does not list R2/,
        ],
        [
          setRow(COMMITTED, "R1", "DONE", "m2-fx-r1/` `docs/research/experiments/m2-fx-r2", R1_FIG),
          /the evidence cell must be one pack/,
        ],
      ];
      for (const [text, pattern] of cases) {
        const r = check(text);
        expect(r.status).toBe(1);
        expect(r.mismatch.join("\n")).toMatch(pattern);
      }
    },
    T,
  );

  it(
    "renders every ineligible cause in the Recomputed cell, in the evidence check's order",
    () => {
      // Expected by hand: the r3 fixture's figures, plus 4 more ineligible kill-app trials,
      // one per non-harness cause, listed in INELIGIBLE_CAUSES order (not alphabetical).
      const fig = R3_FIG.replace(
        "2 ineligible (harness cause 2)",
        "6 ineligible (harness cause 2, gate not called 1, no verdict 1, no DONE claim 1, " +
          "fault did not land 1)",
      );
      const doc = status(setRow(COMMITTED, "R3", "DONE", "m2-fx-r3-mixed", fig), 1, 7, 0);
      const r = check(doc);
      expect(r.mismatch).toEqual([]);
      expect(r.status).toBe(0);
      const sorted = fig.replace(
        "harness cause 2, gate not called 1, no verdict 1, no DONE claim 1, fault did not land 1",
        "fault did not land 1, gate not called 1, harness cause 2, no DONE claim 1, no verdict 1",
      );
      const bad = check(status(setRow(COMMITTED, "R3", "DONE", "m2-fx-r3-mixed", sorted), 1, 7, 0));
      expect(bad.status).toBe(1);
      expect(bad.mismatch.join("\n")).toMatch(/^MISMATCH R3: recomputed figures/m);
    },
    T,
  );

  it(
    "keeps rows with no recomputation (R4, R5, R6, R8) PENDING",
    () => {
      const r = check(setRow(COMMITTED, "R4", "DONE", "m2-fx-r1", R1_FIG));
      expect(r.status).toBe(1);
      expect(r.mismatch.join("\n")).toMatch(
        /MISMATCH R4: evidence: R4 has no recomputation in this script yet/,
      );
    },
    T,
  );
});

describe("m2-scorecard-check: the number sweep and layout", () => {
  it(
    "fails an unattributed number in a PENDING row, the preamble and a section",
    () => {
      const cases: [string, string, RegExp][] = [
        [
          "| R5 | Oracles: mutation self-test,",
          "| R5 | Oracles: 3 mutation self-tests,",
          /UNATTRIBUTED R5: number sweep: .*'3'/,
        ],
        [
          "No hand tallies and no",
          "No hand tallies (12 rows) and no",
          /UNATTRIBUTED status: number sweep: .*'12'/,
        ],
        [
          "| R6 | Multi-step Calc with one targeted retry; host-only Writer oracle | PENDING | — | — |",
          "| R6 | Multi-step Calc with one targeted retry; host-only Writer oracle | PENDING | — | 7 of 30 |",
          /MISMATCH R6: recomputed cell/,
        ],
        [
          "(convert-deadline, deploy-copy, sshd, timeout, load)",
          "(convert-deadline, deploy-copy, sshd, timeout, load; 4 seen)",
          /UNATTRIBUTED process: number sweep: .*'4'/,
        ],
      ];
      for (const [from, to, pattern] of cases) {
        const r = check(mutate(COMMITTED, from, to));
        expect(r.status).toBe(1);
        expect([...r.mismatch, ...r.unattributed].join("\n")).toMatch(pattern);
      }
    },
    T,
  );

  it(
    "checks each pass bar against the code constant and the plan",
    () => {
      for (const [from, to] of [
        ["about 100 gated trials", "about 90 gated trials"],
        ["underpowered below 6 discordant", "underpowered below 5 discordant"],
        ["a 90-second demo", "a 60-second demo"],
        ["trial started at load 10 or more fails", "trial started at load 12 or more fails"],
      ] as const) {
        const r = check(mutate(COMMITTED, from, to));
        expect(r.status).toBe(1);
        expect(r.mismatch.join("\n")).toMatch(/the doc no longer says/);
      }
    },
    T,
  );

  it(
    "fails when the plan's bar moves away from the doc and the code",
    () => {
      const plan = readFileSync("docs/product/m2-plan-draft.md", "utf8");
      for (const [from, to, pattern] of [
        [
          "About **100** gated trials",
          "About **120** gated trials",
          /pass bar 'about 100 gated trials'.*the plan says 120/,
        ],
        ["30 paired trials", "40 paired trials", /pass bar '30 paired trials'.*the plan says 40/],
        [
          "**0 false successes**",
          "**1 false successes**",
          /pass bar '0 false successes'.*the plan says 1/,
        ],
      ] as const) {
        const r = check(COMMITTED, mutate(plan, from, to));
        expect(r.status).toBe(1);
        expect(r.mismatch.join("\n")).toMatch(pattern);
      }
    },
    T,
  );

  it(
    "fails a wrong row count in the status line",
    () => {
      const r = check(status(COMMITTED, 1, 7, 0));
      expect(r.status).toBe(1);
      expect(r.mismatch.join("\n")).toMatch(
        /MISMATCH status: row statuses: expected 'Status: 0 of 8 rows DONE, 8 PENDING, 0 NOT DONE.'/,
      );
    },
    T,
  );

  it(
    "fails unknown, extended, nested and duplicate headings, and a duplicate row",
    () => {
      const r1 = COMMITTED.split("\n").find((l) => l.startsWith("| R1 |"))!;
      const cases: [string, RegExp][] = [
        [
          `${COMMITTED}\n## Notes\n\nnothing\n`,
          /MISMATCH layout: ## Notes: a heading this script does not classify/,
        ],
        [
          mutate(COMMITTED, "## How the check works", "## How the check works (v2)"),
          /## How the check works \(v2\)/,
        ],
        [
          `${COMMITTED}\n> ## Sneaky 31 of 40\n`,
          /> ## Sneaky 31 of 40: a heading this script does not classify/,
        ],
        [`${COMMITTED}\nSneaky\n---\n`, /Sneaky \/ ---: a heading this script does not classify/],
        [
          `${COMMITTED}\n## How the check works\n`,
          /a second section under a heading already classified/,
        ],
        [mutate(COMMITTED, r1, `${r1}\n${r1}`), /duplicate criterion row R1/],
        [
          mutate(
            COMMITTED,
            "| # | Criterion | Status | Evidence | Recomputed |",
            "| # | Criterion | Status | Evidence | Figures |",
          ),
          /the header line must be exactly/,
        ],
        [
          mutate(COMMITTED, "|---|---|---|---|---|", "|---|---|---|---|---|7|"),
          /the separator line must be exactly/,
        ],
      ];
      for (const [text, pattern] of cases) {
        const r = check(text);
        expect(r.status).toBe(1);
        expect(r.mismatch.join("\n")).toMatch(pattern);
      }
    },
    T,
  );

  it(
    "pins identifier words: a renamed script is a changed claim",
    () => {
      let r = check(
        mutate(
          COMMITTED,
          "`python3 scripts/m2-scorecard-check.py` reads",
          "`python4 scripts/m2-scorecard-check.py` reads",
        ),
      );
      expect(r.status).toBe(1);
      expect(r.unattributed.join("\n")).toMatch(/python4/);
      // A swap between two allowlisted words passes the allowlist; only the per-section pin catches it.
      r = check(
        mutate(
          COMMITTED,
          "`scripts/m2-evidence-check.ts --all`",
          "`scripts/m2-scorecard-check.ts --all`",
        ),
      );
      expect(r.status).toBe(1);
      expect(r.unattributed).toEqual([]);
      expect(r.mismatch.join("\n")).toMatch(
        /MISMATCH process: identifier words: word 1: the doc has 'm2-scorecard-check' where IDENTIFIER_PINS has 'm2-evidence-check'/,
      );
    },
    T,
  );
});

describe("m2-scorecard-check: the R7 definition is pinned (lead ruling 02:52Z)", () => {
  it(
    "fails when the R7 criterion drops or narrows 'total over ALL trials / verified count' or the null rule",
    () => {
      const cases: [string, string][] = [
        // The verifier's round-2 rewrite: sum over verified rows only.
        [
          "each the total over ALL of the arm's trials (failed and refuted trials still cost money) divided by its verified count",
          "each summed over verified rows",
        ],
        ["the total over ALL of the arm's trials", "the total over the arm's verified trials"],
        ["divided by its verified count", "divided by its trial count"],
        [" divided by its verified count (accepted DONE the grader passes)", ""],
        ["A null cost is unmeasured, never 0", "A null cost counts as 0"],
        // Every pinned phrase kept, but verified-rows-only wording added beside it.
        [
          "A null cost is unmeasured, never 0",
          "Each is summed over verified rows only. A null cost is unmeasured, never 0",
        ],
      ];
      for (const [from, to] of cases) {
        const r = check(mutate(COMMITTED, from, to));
        expect(r.status, `${from} -> ${to}`).toBe(1);
        expect(r.mismatch.join("\n")).toMatch(/^MISMATCH R7: /m);
      }
      expect(check(COMMITTED).status).toBe(0);
    },
    T,
  );
});

describe("m2-scorecard-check: the R7 definition is pinned exactly (N4, round 2 of #490)", () => {
  const DOC_NULL = "A null cost is unmeasured, never 0";
  const PLAN_NULL = "A null cost is unmeasured and never counts as 0";
  const inDoc = (sentence: string) => mutate(COMMITTED, DOC_NULL, `${sentence} ${DOC_NULL}`);
  const inPlan = (sentence: string) => mutate(PLAN, PLAN_NULL, `${sentence} ${PLAN_NULL}`);
  const PLAN_R7_LINE = PLAN.split("\n").find((l) => l.startsWith("| **R7** |"))!;
  const FAKE_R7 =
    "| **R7** | **Cost per verified task** | Sum over verified rows only | Ledgers | Sums verified rows |";
  const extraPlanR7 = (where: "after" | "before" | "duplicate") =>
    mutate(
      PLAN,
      PLAN_R7_LINE,
      where === "after"
        ? `${PLAN_R7_LINE}\n${FAKE_R7}`
        : where === "before"
          ? `${FAKE_R7}\n${PLAN_R7_LINE}`
          : `${PLAN_R7_LINE}\n${PLAN_R7_LINE}`,
    );
  // Every rewrite from the round-1 verdict on #490 (the three #487 ones first). Each keeps all
  // of the old pinned phrases yet restricts the sum; a word list let 9 of them through.
  const rewrites: [string, string, string | undefined][] = [
    [
      "#487-1 doc: summed over the verified tasks only",
      inDoc(
        "Each summed over the verified tasks only; the total over ALL of the arm's trials is not used.",
      ),
      undefined,
    ],
    [
      "#487-2 plan: sums cost fields over verified rows",
      COMMITTED,
      mutate(PLAN, "sums cost fields over all trials", "sums cost fields over verified rows"),
    ],
    [
      "#487-3 plan: the total over the arm's verified trials",
      COMMITTED,
      mutate(
        PLAN,
        "each as the total over ALL of the arm's trials",
        "each as the total over the arm's verified trials",
      ),
    ],
    ["plan: Verified-status trials", COMMITTED, inPlan("Sum only over Verified-status trials.")],
    [
      "plan: Unverified trials dropped",
      COMMITTED,
      inPlan("Unverified trials are dropped from the sum."),
    ],
    [
      "doc: trials the grader passed",
      inDoc("Only trials the grader passed are summed."),
      undefined,
    ],
    [
      "doc: accepted DONE claims only",
      inDoc("Costs are summed over accepted DONE claims only."),
      undefined,
    ],
    [
      "doc: failed and refuted excluded",
      inDoc("Failed and refuted trials are excluded from the sum."),
      undefined,
    ],
    ["doc: winning trials", inDoc("The sum covers the arm's winning trials."), undefined],
    ["doc: pass-graded trials", inDoc("Summed over pass-graded trials."), undefined],
    [
      "plan: trials counted in the verified count",
      COMMITTED,
      inPlan("Only the trials counted in the verified count are summed."),
    ],
    [
      "plan: per verified task, over those tasks alone",
      COMMITTED,
      inPlan("Costs are summed per verified task, over those tasks alone."),
    ],
    [
      "doc: per verified task, only those count",
      inDoc("Each total is taken per verified task: only those count."),
      undefined,
    ],
    // The canonical text kept whole with a restriction appended or prepended: a substring pin
    // would pass these.
    [
      "doc: restriction appended after the canonical text",
      mutate(COMMITTED, `${DOC_NULL} |`, `${DOC_NULL}. Only verified trials are summed |`),
      undefined,
    ],
    [
      "plan: restriction prepended to the check cell",
      COMMITTED,
      mutate(PLAN, "| The check sums", "| For verified rows only: The check sums"),
    ],
    // Round-1 cases kept: a dropped denominator, a null counted as 0, an extra sentence in the plan.
    [
      "doc: trial count denominator",
      mutate(COMMITTED, "divided by its verified count", "divided by its trial count"),
      undefined,
    ],
    ["doc: null counts as 0", mutate(COMMITTED, DOC_NULL, "A null cost counts as 0"), undefined],
    ["plan: only successful trials", COMMITTED, inPlan("Only successful trials are summed.")],
    ["plan: null counts as 0", COMMITTED, mutate(PLAN, PLAN_NULL, "A null cost counts as 0")],
    [
      "plan: evidence cell changed",
      COMMITTED,
      mutate(PLAN, "| Per-trial cost fields in the ledgers |", "| Ledgers |"),
    ],
    // Round-2 nit N-A: the plan must hold exactly one R7 row. A second row after (or before)
    // the pinned one restates the definition unchecked; even an exact duplicate fails.
    ["plan: a second R7 row after the pinned one", COMMITTED, extraPlanR7("after")],
    ["plan: a second R7 row before the pinned one", COMMITTED, extraPlanR7("before")],
    ["plan: the pinned R7 row duplicated verbatim", COMMITTED, extraPlanR7("duplicate")],
    // Round-2 surviving mutants: Y1 (cell-count check removed; zip truncates), Y2 (a
    // case-insensitive compare), Y3 (punctuation stripped by the normalisation).
    [
      "Y1 plan: an extra cell appended to the R7 row",
      COMMITTED,
      mutate(
        PLAN,
        "divides by the verified count |",
        "divides by the verified count | verified rows only |",
      ),
    ],
    [
      "Y2 doc: case only, ALL -> all",
      mutate(COMMITTED, "the total over ALL", "the total over all"),
      undefined,
    ],
    [
      "Y2 plan: case only, ALL -> all",
      COMMITTED,
      mutate(PLAN, "the total over ALL of the arm's", "the total over all of the arm's"),
    ],
    [
      "Y3 doc: punctuation only, a trailing period",
      mutate(COMMITTED, `${DOC_NULL} |`, `${DOC_NULL}. |`),
      undefined,
    ],
    [
      "Y3 plan: punctuation only, a trailing period",
      COMMITTED,
      mutate(PLAN, "never counts as 0 |", "never counts as 0. |"),
    ],
  ];

  it(
    "fails every rewrite with a MISMATCH naming the ruling, and passes a whitespace-only reflow",
    () => {
      for (const [name, doc, plan] of rewrites) {
        const r = check(doc, plan);
        expect(r.status, name).toBe(1);
        const where = plan === undefined ? "the R7 criterion differs" : "the plan's R7 row differs";
        expect(r.mismatch.join("\n"), name).toMatch(
          new RegExp(
            `^MISMATCH R7: R7 definition \\(lead ruling 02:52Z: total cost of ALL trials.*${where}`,
            "m",
          ),
        );
      }
      // N-A names its cause.
      expect(check(COMMITTED, extraPlanR7("duplicate")).mismatch.join("\n")).toMatch(
        /the plan's R7 row differs from PLAN_R7_CANONICAL: expected exactly one \| \*\*R7\*\* \| row, found 2/,
      );
      // Whitespace-only reflow of both texts: padding, doubled spaces, tabs. Still passes.
      const docLine = COMMITTED.split("\n").find((l) => l.startsWith("| R7 |"))!;
      const docReflow = COMMITTED.replace(
        docLine,
        docLine
          .replace("| R7 | ", "|  R7  |   ")
          .replaceAll(", each the total", ",   each\tthe  total"),
      );
      expect(docReflow).not.toBe(COMMITTED);
      const planLine = PLAN.split("\n").find((l) => l.startsWith("| **R7** |"))!;
      const planReflow = PLAN.replace(
        planLine,
        planLine
          .replace("| **R7** | ", "|  **R7**  |  ")
          .replaceAll(" divided by ", "  divided\t by "),
      );
      expect(planReflow).not.toBe(PLAN);
      expect(check(docReflow, planReflow).status).toBe(0);
      expect(check(COMMITTED, PLAN).status).toBe(0);
    },
    T,
  );
});

describe("m2-scorecard-check: the load gate agrees with the runbook", () => {
  it(
    "fails when the eval runbook's load gate moves away from LOAD_GATE",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "m2-scorecard-runbook-"));
      const runbook = join(dir, "eval-runbook.md");
      const doc = join(dir, "m2-scorecard.md");
      writeFileSync(doc, COMMITTED);
      const text = readFileSync("docs/eval-runbook.md", "utf8");
      writeFileSync(runbook, text);
      expect(run(["--doc", doc, "--runbook", runbook]).status).toBe(0);
      writeFileSync(
        runbook,
        mutate(text, "1-min load stays under 10 for", "1-min load stays under 12 for"),
      );
      const r = run(["--doc", doc, "--runbook", runbook]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/MISMATCH process: load gate: .*eval-runbook load gate = 12/);
    },
    T,
  );
});

describe("m2-evidence-check --all (CI gate)", () => {
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/m2-evidence-check.ts", ...args], {
      encoding: "utf8",
      timeout: T,
    });

  it(
    "passes on the committed tree",
    () => {
      const r = cli("--all");
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).packs).toBeInstanceOf(Array);
    },
    T,
  );

  it(
    "fails an m2-* directory without a valid pack, and passes a clean one",
    () => {
      const bad = cli("--all", "--root", root);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toMatch(/ERROR .*m2-fx-nomanifest: pack.json: missing/);
      expect(bad.stderr).toMatch(/ERROR .*m2-fx-r1-load: g7: started at host 1-minute load 12/);
      const good = cli(join(root, "m2-fx-r1"), join(root, "m2-fx-r3"));
      expect(good.status).toBe(0);
    },
    T,
  );

  it(
    "rejects bad usage",
    () => {
      expect(cli().status).toBe(2);
      expect(cli("--all", "--bogus").status).toBe(2);
    },
    T,
  );
});
