import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBaselineRow } from "../../src/baseline/index.ts";

/**
 * TIF-128 / M1-031: a C1 row records the instruction it was given.
 *
 * The rule, and why it is two-sided: a C1 row must carry a non-empty
 * `instruction`, OR declare `instructionUnrecorded: true` and carry none.
 *
 * Requiring it unconditionally is the obvious rule and it is wrong here. The 29
 * recorded arm-002 rows were produced before the field existed; making it
 * mandatory would have silently invalidated every one of them, turning real
 * evidence into failed validation with no code change to explain it. Measured:
 * 29 of 29 became invalid under the unconditional rule.
 *
 * So the marker exists to keep the historical gap explicit rather than implied,
 * and the tests below pin BOTH directions - a new row forgetting the field is
 * rejected, and a documented legacy row still validates.
 */

const legacy = JSON.parse(
  readFileSync(join(process.cwd(), "docs/research/experiments/c1-arm-002/rows/0.json"), "utf8"),
) as Record<string, unknown>;

/** A C1 row with neither the field nor the marker. */
function newRowWithoutInstruction(): Record<string, unknown> {
  const r = { ...legacy };
  delete r.instructionUnrecorded;
  return r;
}

describe("a C1 row must record its instruction or declare the gap", () => {
  it("accepts a row carrying the instruction", () => {
    expect(isBaselineRow({ ...newRowWithoutInstruction(), instruction: "Set x, and save." })).toBe(
      true,
    );
  });

  it("rejects a row with neither the instruction nor the marker", () => {
    // The property M1-031 exists for: a new row that forgets the field must fail
    // rather than ship evidence whose parity cannot be checked.
    expect(isBaselineRow(newRowWithoutInstruction())).toBe(false);
  });

  it("rejects an empty instruction rather than treating it as present", () => {
    // An empty string is present-but-empty. `str` rejects it, so this pins that
    // a C1 row cannot satisfy the rule with a value that records nothing.
    expect(isBaselineRow({ ...newRowWithoutInstruction(), instruction: "" })).toBe(false);
  });

  it("accepts a legacy row that declares it predates the field", () => {
    // Verbatim from arm-002. If this flips, the recorded evidence has been
    // invalidated by a validator change rather than by anything in the artifact.
    expect(isBaselineRow(legacy)).toBe(true);
    expect(legacy.instruction).toBeUndefined();
    expect(legacy.instructionUnrecorded).toBe(true);
  });

  it("requires the marker to be exactly true, not merely truthy", () => {
    // Nothing pinned this, so relaxing `=== true` to a truthy check would have
    // passed the suite while letting `"true"`, 1 or {} stand in for the marker.
    // The marker means "this record predates the field" - a fact, not a flag to
    // be approximated.
    for (const marker of ["true", 1, {}, []]) {
      const row = { ...newRowWithoutInstruction(), instructionUnrecorded: marker };
      expect(isBaselineRow(row), `marker ${JSON.stringify(marker)} must not count`).toBe(false);
    }
    // `false` is the honest value for a row that SHOULD have an instruction.
    expect(isBaselineRow({ ...newRowWithoutInstruction(), instructionUnrecorded: false })).toBe(
      false,
    );
  });

  it("does not constrain non-C1 rows", () => {
    // Discovery's live runner has no sentence and must not be forced to invent
    // one; only the screenshot baseline is prompted.
    const hcu = { ...newRowWithoutInstruction(), subArm: "hcu" };
    expect(isBaselineRow(hcu)).toBe(true);
  });

  it("EVERY recorded C1 row in the repo validates, not just arm-002's", () => {
    // The first version of this test swept only arm-002's ledger, and that is
    // exactly how a real defect got through: the rule invalidated two rows under
    // docs/research/experiments/c1-arm-001/ that were valid before it, and
    // nothing failed. Annotating one corpus and testing that corpus is not a
    // check. This scans the WHOLE repo, not one directory: the first version was
    // scoped to docs/research and that is how a defect survived a round - two C1
    // corpora under viewer/fixtures/real/ are rejected by this rule and the sweep
    // could not see them. A corpus the rule rejects, with no check that notices,
    // is the class of bug this test exists for - so the sweep walks everything and
    // skips only the directories that cannot contain recorded evidence.
    const root = process.cwd();
    const SKIP = new Set([
      "node_modules",
      ".git",
      "dist",
      "build",
      "coverage",
      ".next",
      "target",
      "__pycache__",
    ]);
    const found: Array<{ where: string; row: unknown }> = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(full);
          continue;
        }
        if (!entry.name.endsWith(".json")) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(full, "utf8"));
        } catch {
          continue; // a non-row JSON file is not evidence either way
        }
        const walk = (node: unknown, where: string): void => {
          if (Array.isArray(node)) {
            node.forEach((v, i) => {
              walk(v, `${where}[${i}]`);
            });
            return;
          }
          if (!node || typeof node !== "object") return;
          const o = node as Record<string, unknown>;
          if (o.subArm === "c1" || o.subArm === "c2" || o.subArm === "hcu") {
            found.push({ where, row: node });
          }
          for (const [k, v] of Object.entries(o)) walk(v, `${where}.${k}`);
        };
        walk(parsed, full.replace(`${root}/`, ""));
      }
    };
    visit(root);
    expect(found.length).toBeGreaterThan(29); // arm-002 alone is 29
    const invalid = found.filter((f) => !isBaselineRow(f.row));
    expect(invalid.map((f) => f.where)).toEqual([]);
  });
});
