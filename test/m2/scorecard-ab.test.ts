/**
 * The scorecard's experiment row AB (plan §2.1a): the corrections A/B, kept apart from R1-R8,
 * experiment-only. scripts/m2-scorecard-check.py recomputes its status and figures from a cited
 * A/B pack (src/m2/ab-pack.ts) and refuses everything else. Expected figures come from the
 * fixture's counts and the independent reference values in test/m2/corrections-ab.test.ts
 * (p = 0.017578125 -> "0.0176"; CI 0.01622-0.16157 -> "0.016–0.162"), not from the code under test.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AB_TASKS, abArm, stage1Arms, writeAbPack } from "./ab-fixture.ts";
import { manifest, r1Trials, writePack } from "./pack-fixture.ts";

const CHECK = "scripts/m2-scorecard-check.py";
const DOC = readFileSync("docs/m2-scorecard.md", "utf8");
const PLAN = readFileSync("docs/product/m2-plan-draft.md", "utf8");
const REPO = resolve(import.meta.dirname, "..", "..");
const T = 120_000;

const S0_FIG =
  "Stage 0 plumbing: 30 pairs; effect claim null (not claimed); experiment-only, never R1 evidence";
const S1_FIG =
  "Stage 1: 100 pairs; both 50, ON only 12, OFF only 3, neither 35; one-sided sign test p = 0.0176; " +
  "95% CI on the paired difference 0.016–0.162; corrections help; experiment-only, never R1 evidence";
const AB_PENDING = "| PENDING | — | — |";

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "m2-scorecard-ab-"));
  writeAbPack("m2-ab-s0", { stage: 0 }, root);
  // The CLI resolves the pre-registration from the repository: a committed file stands in.
  const prereg = { root: REPO, file: "docs/product/m2-plan-draft.md" };
  writeAbPack("m2-ab-s1", { stage: 1, preregRepoFile: prereg }, root);
  const { off } = stage1Arms();
  const sat = AB_TASKS.filter((t) => t.satisfiable).map((t) => t.taskId);
  const on = abArm("on", 1, AB_TASKS, (t) => (t.taskId === sat[0] ? "false-done" : "refuted"));
  writeAbPack("m2-ab-halted", { stage: 1, arms: { on, off }, preregRepoFile: prereg }, root);
  writePack("m2-fx-r1", r1Trials(), manifest(), root);
}, T);

function check(text: string, plan?: string) {
  const dir = mkdtempSync(join(tmpdir(), "m2-scorecard-ab-doc-"));
  writeFileSync(join(dir, "doc.md"), text);
  const extra: string[] = [];
  if (plan !== undefined) {
    writeFileSync(join(dir, "plan.md"), plan);
    extra.push("--plan", join(dir, "plan.md"));
  }
  const r = spawnSync(
    "python3",
    [CHECK, "--doc", join(dir, "doc.md"), "--evidence-root", root, ...extra],
    {
      encoding: "utf8",
      timeout: T,
    },
  );
  return {
    status: r.status,
    stdout: r.stdout,
    errors: r.stderr.split("\n").filter((l) => /^(MISMATCH|UNATTRIBUTED)/.test(l)),
  };
}

const cite = (pack: string) => `\`docs/research/experiments/${pack}/\``;
const AB_LINE = DOC.split("\n").find((l) => l.startsWith("| AB |")) as string;
/** Replace the AB row's last three cells (status, evidence, recomputed). */
function abCells(cells: string, text = DOC) {
  expect(AB_LINE.endsWith(AB_PENDING)).toBe(true);
  return text.replace(AB_LINE, `${AB_LINE.slice(0, -AB_PENDING.length)}${cells}`);
}
function setAb(status: string, pack: string, figures: string, text = DOC) {
  return abCells(`| ${status} | ${cite(pack)} | ${figures} |`, text);
}

describe("the scorecard's experiment row AB", () => {
  it(
    "the committed scorecard has the row PENDING, in its own section, outside the status line",
    () => {
      const r = check(DOC);
      expect(r.errors).toEqual([]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/experiment row AB: PENDING/);
      expect(DOC).toContain("Status: 0 of 8 rows DONE, 8 PENDING, 0 NOT DONE.");
      const head = DOC.indexOf("## Experiment row (experiment-only, never R1 evidence)");
      expect(head).toBeGreaterThan(DOC.indexOf("| R8 |"));
      expect(DOC.indexOf("| AB |")).toBeGreaterThan(head);
    },
    T,
  );

  it(
    "a Stage-0 pack makes it PLUMBING with a null effect claim, whatever the numbers",
    () => {
      const ok = check(setAb("PLUMBING", "m2-ab-s0", S0_FIG));
      expect(ok.errors).toEqual([]);
      expect(ok.stdout).toMatch(/experiment row AB: PLUMBING/);
      const claimed = check(setAb("REPORTED", "m2-ab-s0", S0_FIG));
      expect(claimed.errors.join("\n")).toMatch(
        /AB status: .*the doc says REPORTED, the pack gives PLUMBING/,
      );
      // A Stage-0 split quoted as an effect is not the recomputed figure.
      const spun = check(setAb("PLUMBING", "m2-ab-s0", `${S0_FIG}; corrections help`));
      expect(spun.errors.join("\n")).toMatch(/AB recomputed figures/);
    },
    T,
  );

  it(
    "a Stage-1 pack makes it REPORTED with the pre-registered test's figures",
    () => {
      const ok = check(setAb("REPORTED", "m2-ab-s1", S1_FIG));
      expect(ok.errors).toEqual([]);
      expect(ok.stdout).toMatch(/experiment row AB: REPORTED/);
      const wrongP = check(setAb("REPORTED", "m2-ab-s1", S1_FIG.replace("p = 0.0176", "p = 0.01")));
      expect(wrongP.errors.join("\n")).toMatch(/AB recomputed figures/);
      const plumbing = check(setAb("PLUMBING", "m2-ab-s1", S1_FIG));
      expect(plumbing.errors.join("\n")).toMatch(/the doc says PLUMBING, the pack gives REPORTED/);
    },
    T,
  );

  it(
    "a halted pack cannot be cited, and the row cites A/B packs only",
    () => {
      const halted = check(setAb("REPORTED", "m2-ab-halted", S1_FIG));
      expect(halted.errors.join("\n")).toMatch(/A\/B pack passes every gate: .*INTEGRITY INCIDENT/);
      const rPack = check(setAb("REPORTED", "m2-fx-r1", S1_FIG));
      expect(rPack.errors.join("\n")).toMatch(/m2-fx-r1 is not an A\/B pack/);
      const unknown = check(setAb("PENDING", "m2-ab-nope", "—"));
      expect(unknown.errors.join("\n")).toMatch(/is not a committed pack/);
    },
    T,
  );

  it(
    "an R row can never cite an A/B pack",
    () => {
      const line = DOC.split("\n").find((l) => l.startsWith("| R1 |")) as string;
      const cells = line.split("|");
      cells[3] = " DONE ";
      cells[4] = ` ${cite("m2-ab-s1")} `;
      cells[5] = " x ";
      const r = check(DOC.replace(line, cells.join("|")));
      expect(r.errors.join("\n")).toMatch(/m2-ab-s1\/pack.json does not list R1 in rows/);
    },
    T,
  );

  it(
    "a PENDING row quotes nothing, the status is one of three, and the row stays out of the R table",
    () => {
      const status = check(abCells("| DONE | — | — |"));
      expect(status.errors.join("\n")).toMatch(/AB status: status 'DONE' is not one of/);
      const figures = check(abCells("| PENDING | — | 30 pairs |"));
      expect(figures.errors.join("\n")).toMatch(/AB recomputed cell/);
      const abLine = DOC.split("\n").find((l) => l.startsWith("| AB |")) as string;
      const moved = DOC.replace(`${abLine}\n`, "").replace("| R8 |", `${abLine}\n| R8 |`);
      const r = check(moved);
      expect(r.status).toBe(1);
      expect(r.errors.join("\n")).toMatch(/an AB row outside '## Experiment row/);
    },
    T,
  );

  it(
    "the pre-registered figures are pinned to the code and to the plan's AB row",
    () => {
      const doc = check(DOC.replace("Stage 1: 100 pairs per arm", "Stage 1: 60 pairs per arm"));
      expect(doc.errors.join("\n")).toMatch(/AB design 'Stage 1: 100 pairs per arm'/);
      const plan = check(DOC, PLAN.replace("at alpha **0.05**", "at alpha **0.1**"));
      expect(plan.errors.join("\n")).toMatch(/AB design 'at alpha 0.05'.*the plan says 0.1/);
      const s0 = check(DOC, PLAN.replace("Stage 0: **30** pairs", "Stage 0: **20** pairs"));
      expect(s0.errors.join("\n")).toMatch(/the plan says 20/);
    },
    T,
  );
});
