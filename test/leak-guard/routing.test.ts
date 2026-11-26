/**
 * Routing lint (TIF-98, part 2): no module writes outward dataset, episode or bundle output
 * without `src/leak-guard/serialize.ts`. See `routing.ts` for the rule and `PENDING` (each
 * entry a TO FILE switch-over). The synthetic cases prove the lint itself catches each way
 * a raw write can hide (mutation-proved in the PR's table).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { trackedFiles } from "../../src/leak-guard/scan.ts";
import {
  analyse,
  analyseTree,
  HELPER,
  isOutwardWriter,
  isRouted,
  PENDING,
  routingProblems,
} from "./routing.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");

describe("routing lint: outward writers route through the shared serialization helper", () => {
  it("every outward writer under src/ routes through the helper or is a listed TO FILE", () => {
    const modules = analyseTree(ROOT, trackedFiles(ROOT));
    expect(modules.length).toBeGreaterThan(100);
    expect(routingProblems(modules)).toEqual([]);
    // The writers the lint knows about today (so a silent detector change shows here).
    expect(
      modules
        .filter(isOutwardWriter)
        .map((m) => m.file)
        .sort(),
    ).toEqual([
      "src/dataset/export.ts",
      "src/episode/export.ts",
      "src/foundry/hidden-split/evidence.ts",
      "src/pilot/runner.ts",
    ]);
  });

  it("every PENDING entry names its switch-over", () => {
    for (const [file, p] of Object.entries(PENDING)) {
      expect(file.startsWith("src/")).toBe(true);
      expect(p.toFile.length).toBeGreaterThan(20);
    }
  });
});

const helperImport = 'import { writeOutward } from "../leak-guard/serialize.ts";';

describe("routing lint: the AST check catches every way a raw outward write can hide", () => {
  const cases: ReadonlyArray<[string, string, string]> = [
    [
      "named import in an outward area",
      "src/dataset/new-writer.ts",
      'import { writeFileSync } from "node:fs";\nwriteFileSync("x", "y");',
    ],
    ["aliased import", "src/proof/b.ts", 'import { writeFileSync as w } from "fs";\nw("x", "y");'],
    [
      "namespace import",
      "src/proof/c.ts",
      'import * as fs from "node:fs";\nfs.appendFileSync("x", "y");',
    ],
    ["default import", "src/proof/d.ts", 'import fs from "node:fs";\nfs.createWriteStream("x");'],
    [
      "fs.promises",
      "src/proof/e.ts",
      'import * as fs from "node:fs";\nawait fs.promises.writeFile("x", "y");',
    ],
    [
      "node:fs/promises",
      "src/proof/f.ts",
      'import { writeFile } from "node:fs/promises";\nawait writeFile("x", "y");',
    ],
    [
      "an export* function outside an outward area",
      "src/pilot/other.ts",
      'import { writeFileSync } from "node:fs";\nexport function exportRows(d: string) { writeFileSync(d, "y"); }',
    ],
    [
      "an export file name",
      "src/foo/bundle-writer.ts",
      'import { renameSync } from "node:fs";\nrenameSync("a", "b");',
    ],
    [
      "an outward artifact name",
      "src/foo/anything.ts",
      'import { writeFileSync } from "node:fs";\nwriteFileSync(dir + "/x", "y");\nconst f = "records.jsonl";',
    ],
    [
      "importing the helper but still writing raw",
      "src/dataset/half.ts",
      `${helperImport}\nimport { writeFileSync } from "node:fs";\nwriteFileSync("x", "y");`,
    ],
  ];
  for (const [name, file, src] of cases)
    it(`flags: ${name}`, () => {
      const m = analyse(file, src);
      expect(isOutwardWriter(m)).toBe(true);
      expect(routingProblems([m], {})).toEqual([{ file, problem: "unrouted" }]);
    });

  it("a module that routes through the helper (no raw write) passes", () => {
    const m = analyse("src/dataset/routed.ts", `${helperImport}\nwriteOutward("x", f, v);`);
    expect(isRouted(m)).toBe(true);
    expect(routingProblems([m], {})).toEqual([]);
  });

  it("non-outward writers (a local store, a run log) are not flagged", () => {
    const m = analyse(
      "src/schedule/state.ts",
      'import { writeFileSync } from "node:fs";\nexport function save(d: string) { writeFileSync(d, "y"); }',
    );
    expect(isOutwardWriter(m)).toBe(false);
  });

  it("the helper itself is exempt; a stale PENDING entry fails; an expected one may be absent", () => {
    expect(isOutwardWriter(analyse(HELPER, readHelper()))).toBe(false);
    const routed = analyse("src/dataset/routed.ts", `${helperImport}\nwriteOutward("x", f, v);`);
    expect(
      routingProblems([routed], { "src/dataset/routed.ts": { toFile: "x".repeat(30) } }),
    ).toEqual([{ file: "src/dataset/routed.ts", problem: "stale-pending" }]);
    expect(routingProblems([], { "src/gone.ts": { toFile: "x".repeat(30) } })).toEqual([
      { file: "src/gone.ts", problem: "stale-pending" },
    ]);
    expect(
      routingProblems([], { "src/later.ts": { toFile: "x".repeat(30), expected: "#1" } }),
    ).toEqual([]);
  });
});

function readHelper(): string {
  return readFileSync(resolve(ROOT, HELPER), "utf8");
}
