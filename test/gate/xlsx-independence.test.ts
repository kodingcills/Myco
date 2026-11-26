/**
 * TIF-274 prerequisite, requirement 4: the gate's xlsx read path and the independent
 * grader's xlsx read path stay separate. The gate's reader (`src/gate/xlsx-document.ts`, via
 * `calc-document.ts`) must not reach `src/benchmark/`, and the grader (`src/benchmark/grade/`)
 * must not reach `src/gate/`. Both walks follow the transitive relative-import graph.
 *
 * The bite checks run the same walker over an overlay in which ONE file gains ONE import of
 * the other side, and show the walk then reports it, in each direction. So a future
 * `import ... from "../benchmark/grade/sheet.ts"` in the gate (or the reverse) fails here.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");
const GATE = join(ROOT, "src", "gate");
const BENCHMARK = join(ROOT, "src", "benchmark");
const GRADER = join(BENCHMARK, "grade");

const GATE_XLSX_ENTRIES = [
  join(GATE, "xlsx-document.ts"),
  // The raw-byte pre-scan and the fixed part names (this PR), entries in their own right.
  join(GATE, "xlsx-prescan.ts"),
  join(GATE, "xlsx-parts.ts"),
  join(GATE, "calc-document.ts"),
  join(GATE, "families.ts"),
];
const GRADER_XLSX_ENTRIES = [
  join(GRADER, "sheet.ts"),
  join(GRADER, "zip.ts"),
  join(GRADER, "grade.ts"),
];

const IMPORT =
  /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

type Source = (file: string) => string;
const disk: Source = (file) => readFileSync(file, "utf8");

/** Every module reachable from `entry` over relative imports. */
function reach(entry: string, source: Source, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const m of source(entry).matchAll(IMPORT)) {
    const spec = (m[1] ?? m[2] ?? m[3] ?? m[4]) as string;
    if (spec.startsWith(".")) reach(resolve(dirname(entry), spec), source, seen);
  }
  return seen;
}

/** Modules under `forbidden` reachable from `entries`, as repo-relative paths. */
function crossings(entries: readonly string[], forbidden: string, source: Source): string[] {
  const hits = new Set<string>();
  for (const entry of entries) {
    for (const mod of reach(entry, source)) {
      if (mod.startsWith(`${forbidden}/`)) hits.add(relative(ROOT, mod));
    }
  }
  return [...hits].sort();
}

/** `disk`, with `line` appended to `file`. */
function overlay(file: string, line: string): Source {
  return (f) => (f === file ? `${disk(f)}\n${line}\n` : disk(f));
}

describe("gate xlsx path and grader xlsx path are independent (TIF-274 prerequisite)", () => {
  it("the gate's xlsx reader is on the gate's walked graph", () => {
    const reached = new Set<string>();
    for (const e of GATE_XLSX_ENTRIES) for (const m of reach(e, disk)) reached.add(m);
    expect(reached).toContain(join(GATE, "xlsx-document.ts"));
    // The reader imports both new modules, so the walk from the reader covers them too.
    const fromReader = [...reach(join(GATE, "xlsx-document.ts"), disk)];
    expect(fromReader).toContain(join(GATE, "xlsx-prescan.ts"));
    expect(fromReader).toContain(join(GATE, "xlsx-parts.ts"));
  });

  it.each(["xlsx-prescan.ts", "xlsx-parts.ts"])(
    "%s imports nothing at all (pure byte and name checks)",
    (file) => {
      expect([...disk(join(GATE, file)).matchAll(IMPORT)]).toEqual([]);
    },
  );

  it.each(["xlsx-prescan.ts", "xlsx-parts.ts"])(
    "bite: %s importing the grader's sheet.ts is reported",
    (file) => {
      const source = overlay(join(GATE, file), 'import "../benchmark/grade/sheet.ts";');
      expect(crossings([join(GATE, file)], BENCHMARK, source)).not.toEqual([]);
    },
  );

  it("the gate's xlsx path reaches nothing under src/benchmark/", () => {
    expect(crossings(GATE_XLSX_ENTRIES, BENCHMARK, disk)).toEqual([]);
  });

  it("the grader's xlsx path reaches nothing under src/gate/", () => {
    expect(crossings(GRADER_XLSX_ENTRIES, GATE, disk)).toEqual([]);
  });

  it("neither side names the other's xlsx reader, even in a non-relative import", () => {
    const code = (f: string) => disk(f).replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "");
    expect(code(join(GATE, "xlsx-document.ts"))).not.toMatch(/benchmark|grade\/(sheet|zip)/);
    for (const f of GRADER_XLSX_ENTRIES) expect(code(f)).not.toMatch(/gate\/|xlsx-document/);
  });

  it("bite check: the walk fails if the gate's reader imports the grader's", () => {
    const source = overlay(
      join(GATE, "xlsx-document.ts"),
      'import { readXlsxGrid } from "../benchmark/grade/sheet.ts";',
    );
    expect(crossings(GATE_XLSX_ENTRIES, BENCHMARK, source)).toEqual([
      "src/benchmark/grade/sheet.ts",
      "src/benchmark/grade/zip.ts",
    ]);
  });

  it("bite check: the walk fails if the grader's reader imports the gate's", () => {
    const source = overlay(
      join(GRADER, "sheet.ts"),
      'import { readXlsxDocument } from "../../gate/xlsx-document.ts";',
    );
    const hits = crossings(GRADER_XLSX_ENTRIES, GATE, source);
    expect(hits).toContain("src/gate/xlsx-document.ts");
  });
});
