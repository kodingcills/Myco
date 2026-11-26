import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  manifest,
  r1Trials,
  r2Manifest,
  r2Trials,
  r3Manifest,
  r3Trials,
  type Trial,
  writePack,
} from "./pack-fixture.ts";

// TIF-273: scripts/m2-scorecard-check.py recomputes every number in docs/m2-scorecard.md
// from committed evidence packs and fails on a mismatch, an unattributed number, an
// unknown heading or zero input. Fixture packs live in private temp dirs.
const CHECK = "scripts/m2-scorecard-check.py";
const DOC = "docs/m2-scorecard.md";
const COMMITTED = readFileSync(DOC, "utf8");
const T = 120_000;

// Expected figures, computed by hand from the fixtures (pack-fixture.ts) and Wilson /
// Clopper-Pearson by formula, not by the code under test.
// Wilson upper bound at 0/n is z²/(n + z²), z = 1.96: 0/92 -> 0.0401, 0/91 -> 0.0405.
const R1_FIG =
  "100 eligible gated trials (8 faulted), 2 ineligible (harness cause 2); 92 eligible accepted DONE; " +
  "over all gated trials 0 false DONE accepted, 0 accepted ungradable; " +
  "false-accept rate 0/92 (Wilson 0.000–0.040)";
const R2_FIG =
  "30 pairs; myco-gate: false-done 0/20 (Wilson 0.000–0.161), success 20/30 (Wilson 0.488–0.808); " +
  "hcu+shell: false-done 10/25 (Wilson 0.234–0.593), success 15/30 (Wilson 0.332–0.668); " +
  "both 15, gate only 5, shell only 0, neither 10; sign test p = 0.0625, underpowered";
// The two kill-app harness faults are ineligible: kill-app is 10 trials, not 12 (D1).
const R3_FIG =
  "30 eligible faulted trials, 2 ineligible (harness cause 2); 0 false successes, 0 on ineligible trials; " +
  "kill-app: false success 0/10 (exact 0.000–0.308), detection 10/10 (exact 0.692–1.000); " +
  "oracle-input-tamper: false success 0/10 (exact 0.000–0.308), detection 10/10 (exact 0.692–1.000); " +
  "screen-injection: false success 0/10 (exact 0.000–0.308), detection 8/8 (exact 0.631–1.000)";
const R7_FIG =
  "hcu+shell: 15 verified of 30; per verified task model $1.0000, wall clock 200.0 s, VM 160.0 s; " +
  "myco-gate: 20 verified of 30; per verified task model $0.7500, wall clock 150.0 s, VM 120.0 s";

let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "m2-scorecard-"));
  writePack("m2-fx-r1", r1Trials(), manifest(), root);
  writePack("m2-fx-r2", r2Trials(), r2Manifest(), root);
  writePack("m2-fx-r3", r3Trials(), r3Manifest(), root);
  writePack(
    "m2-fx-r1-short",
    r1Trials().slice(1),
    manifest({ expectTrials: { "myco-gate": 101 } }),
    root,
  );
  const loud: Trial[] = r1Trials();
  loud[7]!.ops = { ...loud[7]!.ops, hostLoad1mStart: 12 };
  writePack("m2-fx-r1-load", loud, manifest(), root);
  const nullCost: Trial[] = r2Trials();
  nullCost[25]!.arm = { ...nullCost[25]!.arm, cost: { ...nullCost[25]!.arm.cost, modelUsd: null } };
  writePack("m2-fx-r2-null", nullCost, r2Manifest(), root);
  mkdirSync(join(root, "m2-fx-nomanifest"));
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
  t = setRow(t, "R2", "DONE", "m2-fx-r2", R2_FIG);
  t = setRow(t, "R3", "DONE", "m2-fx-r3", R3_FIG);
  t = setRow(t, "R7", "DONE", "m2-fx-r2", R7_FIG);
  return status(t, 4, 4, 0);
}

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
    "passes when R1, R2, R3 and R7 quote exactly what their packs recompute",
    () => {
      const r = check(allDone());
      expect(r.mismatch).toEqual([]);
      expect(r.unattributed).toEqual([]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/rows: 4 DONE, 0 NOT DONE, 4 PENDING/);
    },
    T,
  );

  it(
    "fails and names the row when one recomputed figure changes",
    () => {
      for (const [from, to, row] of [
        ["92 eligible accepted DONE", "93 eligible accepted DONE", "R1"],
        ["gate only 5", "gate only 6", "R2"],
        ["detection 8/8", "detection 9/9", "R3"],
        ["wall clock 150.0 s", "wall clock 149.0 s", "R7"],
      ] as const) {
        const r = check(mutate(allDone(), from, to));
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
        "99 eligible gated trials (8 faulted), 2 ineligible (harness cause 2); 91 eligible accepted DONE; " +
        "over all gated trials 0 false DONE accepted, 0 accepted ungradable; " +
        "false-accept rate 0/91 (Wilson 0.000–0.041)";
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
      expect(ok.mismatch).toEqual([]);
      expect(ok.status).toBe(0);
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
