/**
 * Track R evaluation import boundaries (capability-spec Part 1 §1.1 and §1.2 rule 4):
 *  - the recorder, compiler and derived oracle (`src/recording/`) never import the task-set
 *    definition (`src/recording-eval/`), the fixture generator, or anything from
 *    `src/tasks/intent.ts` that carries expected values (`groundTruth`, parameter sets,
 *    fixture lookup), so a derived oracle's expected values can come only from the recording
 *    and the bindings. (#532's compiler imports the value-shape predicate
 *    `isAutoCorrectImmune` from there; that carries no expected value and stays allowed.)
 *  - the analysis reads grader ROWS and never imports the grader, the gate or the recorder's
 *    replay: it cannot recompute a verdict, only read the independent grader's.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers.ts";

interface Import {
  readonly names: string;
  readonly spec: string;
}
const importsOf = (rel: string): Import[] =>
  [
    ...readFileSync(join(ROOT, rel), "utf8").matchAll(
      /^\s*(?:import|export)\s+([^;]*?)\s*from\s+"([^"]+)"/gms,
    ),
  ].map((m) => ({ names: m[1] as string, spec: m[2] as string }));
const specsOf = (rel: string) => importsOf(rel).map((i) => i.spec);

const INTENT_ALLOWED = new Set(["isAutoCorrectImmune"]);

describe("track R evaluation boundaries", () => {
  it("src/recording/* imports no task-set definition, fixture generator or expected values", () => {
    const files = readdirSync(join(ROOT, "src/recording")).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      for (const { names, spec } of importsOf(`src/recording/${f}`)) {
        expect(spec, f).not.toMatch(/recording-eval/);
        expect(spec, f).not.toMatch(/tasks\/fixture/);
        if (/tasks\/intent/.test(spec)) {
          const imported = names
            .replace(/^type\s+/, "")
            .replace(/[{}]/g, "")
            .split(",")
            .map((n) => n.trim().replace(/^type\s+/, ""))
            .filter((n) => n !== "");
          for (const n of imported) expect(INTENT_ALLOWED.has(n), `${f} imports ${n}`).toBe(true);
        }
      }
    }
  });

  it("the analysis imports only canonical hashing and the marker scanner", () => {
    expect(specsOf("src/recording-eval/analysis.ts").sort()).toEqual([
      "../recording/scrub.ts",
      "./canonical.ts",
    ]);
    expect(specsOf("src/recording-eval/canonical.ts")).toEqual(["node:crypto"]);
  });

  it("the boundary scan sees real imports (self-check)", () => {
    expect(specsOf("src/recording-eval/fr-v1.ts")).toContain("../tasks/intent.ts");
    expect(importsOf("src/recording/compile.ts")).toContainEqual({
      names: "{ isAutoCorrectImmune }",
      spec: "../tasks/intent.ts",
    });
  });
});
