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
    // `str("")` passes a typeof check, so this needs the length test too.
    expect(isBaselineRow({ ...newRowWithoutInstruction(), instruction: "" })).toBe(false);
  });

  it("accepts a legacy row that declares it predates the field", () => {
    // Verbatim from arm-002. If this flips, the recorded evidence has been
    // invalidated by a validator change rather than by anything in the artifact.
    expect(isBaselineRow(legacy)).toBe(true);
    expect(legacy.instruction).toBeUndefined();
    expect(legacy.instructionUnrecorded).toBe(true);
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
    // check. This walks every JSON file under docs/research and validates every
    // embedded C1 row it finds, so a future corpus that predates the field fails
    // here until it is annotated.
    // Scans the WHOLE repo, not just docs/research. The first version scoped
    // itself to docs/research and that is how the round-1 defect survived a
    // round: two C1 corpora under viewer/fixtures/real/ are rejected by this
    // rule and the sweep could not see them. A corpus the rule rejects, with no
    // check that notices, is the class of bug this test exists for - so the
    // sweep walks everything and skips only the directories that cannot contain
    // recorded evidence.
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
