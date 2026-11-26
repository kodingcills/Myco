/**
 * Track G (benchmark package polish): the public package's numbers, versions and refusal
 * texts are the code's, so the docs cannot drift from what the check and task set do.
 * Docs-only guard; it reads the docs and imports constants, nothing else.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { m2SupersededSchema } from "../../schemas/m2-evidence.ts";
import {
  type BenchmarkArmRow,
  COST_BASIS,
  correctionsOnError,
  UNBOUND_R1,
} from "../../src/benchmark/check.ts";
import { GRADER_VERSION } from "../../src/benchmark/grade/grade.ts";
import { buildTaskSet, TASK_SET_VERSION } from "../../src/benchmark/taskset.ts";
import { wilson } from "../../src/foundry/stats.ts";
import { INELIGIBLE_CAUSES, R1_MIN_TRIALS } from "../../src/m2/evidence.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
/** A doc with its line wrapping flattened, so quoted texts match across line breaks. */
const read = (name: string) =>
  readFileSync(join(ROOT, "docs", "benchmark", "public", name), "utf8").replace(
    /[ \t]*\n[ \t]*(?![|#`-]|\n)/g,
    " ",
  );
const card = read("task-set-card.md");
const protocol = read("grading-protocol.md");
const reproduce = read("reproduce-linux.md");
const readme = read("README.md");

describe("public benchmark package matches the code", () => {
  it("the card's composition table is fc-v1's", () => {
    const set = buildTaskSet();
    for (const cls of new Set(set.tasks.map((t) => t.faultClass))) {
      const tasks = set.tasks.filter((t) => t.faultClass === cls);
      const ids = tasks.map((t) => t.taskId);
      const demo = tasks.filter((t) => t.inDemo).length;
      const first = (ids[0] as string).replace(`${TASK_SET_VERSION}-`, "");
      const last = (ids.at(-1) as string).replace(`${TASK_SET_VERSION}-`, "").replace(/^0+/, "");
      const row = new RegExp(
        `^\\| \`${cls}\` \\| ${TASK_SET_VERSION}-${first} to 0*${last} \\| ${tasks.length} \\| ${demo} \\|`,
        "m",
      );
      expect(card, cls).toMatch(row);
    }
    const unsat = set.tasks.filter((t) => !t.satisfiable).length;
    expect(card).toContain(
      `| Satisfiable / unsatisfiable | ${set.tasks.length - unsat} / ${unsat} (the ${unsat} are the invalid-target tasks) |`,
    );
    expect(card).toContain(
      `| Tasks | ${set.tasks.length}, plus a ${set.tasks.filter((t) => t.inDemo).length}-task demo subset`,
    );
    const missingRow = set.tasks.filter((t) => t.intent.rowKey === "EMP-9999").length;
    const missingCol = set.tasks.filter((t) => t.intent.column === "nickname").length;
    expect(card).toContain(
      `${missingRow} name a record key that does not exist (\`EMP-9999\`), ${missingCol} a column that does not exist (\`nickname\`)`,
    );
  });

  it("versions, the R1 bar and the small-sample bound are the code's", () => {
    for (const doc of [card, protocol]) expect(doc).toContain(GRADER_VERSION);
    expect(card).toContain(`\`${TASK_SET_VERSION}\``);
    expect(card).toContain(`there must be at least **${R1_MIN_TRIALS}**`);
    const upper = (wilson(0, 100) as readonly [number, number])[1];
    expect(card).toContain(`about ${(upper * 100).toFixed(1)}%`);
  });

  it("refusal and label texts are quoted exactly", () => {
    expect(protocol).toContain(COST_BASIS);
    // UNBOUND_R1's first clause, as the card quotes it (wrapped).
    const unbound = UNBOUND_R1.slice(0, UNBOUND_R1.indexOf(" (")).replace(/\s+/g, " ");
    expect(card).toContain(unbound);
    for (const doc of [card, protocol, reproduce])
      expect(doc).toContain("dry-run rows are never evidence");
    for (const cause of INELIGIBLE_CAUSES) expect(protocol).toContain(`\`${cause}\``);
    // #514's corrections-off refusal, quoted from the code's own message.
    const corrected = correctionsOnError([
      { trialKey: "t", gate: { called: true, verdict: "verified", corrections: "on" } },
    ] as unknown as BenchmarkArmRow[]) as string;
    const refusal = corrected.slice(corrected.indexOf("): ") + 3);
    expect(refusal).toBe("R1 evidence runs keep corrections off, so these rows are never evidence");
    expect(protocol).toContain(`("${refusal}")`);
    expect(card).toContain('("these rows are never evidence")');
    expect(reproduce).toContain('("these rows are never evidence")');
    for (const doc of [card, protocol, reproduce]) expect(doc).toContain("`gate.corrections");
  });

  it("states the binding detection and denominator rulings (#517 round 1, nits 1-4)", () => {
    // Detection counts both refusing verdicts; test/m2/evidence.test.ts pins the code side
    // ("counts an uncertain verdict as a detection").
    for (const doc of [card, protocol]) expect(doc).toContain("verdict `refuted` or `uncertain`");
    // Nit 1: a replaced attempt is costed by the pack's R7, never by benchmark-check.
    expect(card).toContain("the M2 pack's cost row (R7, which sums superseded attempts)");
    expect(card).toContain("so it never includes a replaced attempt");
    expect(protocol).toContain("never includes a replaced attempt");
    // Nit 2: one run reaches 100 only if every gated trial is eligible, and the pack enforces it.
    expect(card).toContain(
      "One run of fc-v1 reaches 100 only if all 90 of its gated trials are eligible",
    );
    expect(card).toContain("but applies no eligibility rule");
    // The denominator sentence, now that #511 (topped-up runs) is on main.
    expect(card).toContain(
      "it stays in the headline's denominator until it is re-run; a re-run replaces it there",
    );
    // Binding ruling: harness faults never count toward the 100 (#517 round 2, nit 2).
    expect(card).toContain("**Harness faults never count** toward the 100.");
    expect(protocol).toContain("a harness-faulted trial never counts toward the 100");
  });

  it("describes #511's topped-up runs as on main, and nothing from the open #518 (#517 round 2, D2)", () => {
    const flatCard = card.replace(/\s+/g, " ");
    const flatProtocol = protocol.replace(/\s+/g, " ");
    // #511 is merged: no doc calls it pending or future.
    for (const doc of [card, protocol, reproduce, readme]) {
      const flat = doc.replace(/\s+/g, " ");
      expect(flat).not.toMatch(/#511[^.]*\bpending\b/i);
      expect(flat).not.toMatch(/once #511 merges/i);
      // #518 (attempt ledger) is still open: nothing describes it as on main.
      expect(flat).not.toContain("#518");
      expect(flat).not.toMatch(/attempt ledger/i);
    }
    // What main's pack check does (src/m2/evidence.ts checkSuperseded, m2SupersededSchema).
    expect(flatCard).toContain(
      "The M2 evidence pack check (`src/m2/evidence.ts`, #511) enforces these rules and refuses a pack that breaks them.",
    );
    expect(flatProtocol).toContain("the M2 pack check enforces this, #511");
    for (const flat of [flatCard, flatProtocol]) {
      expect(flat).toContain("`superseded.jsonl`");
      expect(flat).toContain("`replacedBy` link");
      expect(flat).toContain("is in no R1, R2 or R3 count");
    }
    expect(m2SupersededSchema.properties).toHaveProperty("replacedBy");
  });

  it("publishes no results and claims no leaderboard or hosted service", () => {
    for (const doc of [card, protocol, reproduce, readme]) {
      // Every mention of a leaderboard is a denial ("no leaderboard").
      const mentions = doc.match(/\S+\s+leaderboard/gi) ?? [];
      for (const m of mentions) expect(m.toLowerCase()).toMatch(/^no\s/);
      expect(doc).not.toMatch(/hosted (?:gate|benchmark) (?:api|service) is available/i);
    }
    // Each place a result will go is marked pending, not filled.
    for (const slot of [
      "| Results | **RESULTS PENDING.** None yet |",
      "R1 result on fc-v1: **RESULTS PENDING.**",
      "Result: **RESULTS PENDING.**",
    ])
      expect(card).toContain(slot);
    expect(readme).toContain("RESULTS PENDING");
  });
});
