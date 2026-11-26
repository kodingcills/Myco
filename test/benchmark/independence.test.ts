/**
 * TIF-267 independence guard: the benchmark grader must not share code with the gating
 * oracle (M2 plan §4: "if it shares code or inputs with the gating oracle, R1 grades
 * itself"). Walks the transitive relative-import graph of every grader module and fails
 * if it leaves `src/benchmark/grade/`, or reaches a process launcher (the gate's persisted
 * check runs `soffice`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");
const GRADER = join(ROOT, "src", "benchmark", "grade");
const ALLOWED_BUILTINS = new Set(["node:crypto", "node:zlib"]);

const IMPORT =
  /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

function specifiers(source: string): string[] {
  return [...source.matchAll(IMPORT)].map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4]) as string);
}

function walk(entry: string, seen = new Map<string, string[]>()): Map<string, string[]> {
  if (seen.has(entry)) return seen;
  const specs = specifiers(readFileSync(entry, "utf8"));
  seen.set(entry, specs);
  for (const spec of specs) {
    if (spec.startsWith(".")) walk(resolve(dirname(entry), spec), seen);
  }
  return seen;
}

const graderFiles = readdirSync(GRADER)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => join(GRADER, f));

describe("benchmark grader independence (TIF-267)", () => {
  it("has modules to check", () => {
    expect(graderFiles.length).toBeGreaterThanOrEqual(4);
  });

  it("imports nothing outside src/benchmark/grade/ except allowed node builtins", () => {
    const violations: string[] = [];
    for (const file of graderFiles) {
      for (const [mod, specs] of walk(file)) {
        if (!mod.startsWith(`${GRADER}/`))
          violations.push(`${relative(ROOT, mod)} reached from ${relative(ROOT, file)}`);
        for (const spec of specs) {
          if (!spec.startsWith(".") && !ALLOWED_BUILTINS.has(spec)) {
            violations.push(`${relative(ROOT, mod)} imports ${spec}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("never names a gate module or a process launcher", () => {
    const forbidden =
      /uno-verifier|filepersist|tasks\/(intent|fixture|calc-record-edit)|core\/verify|child_process|soffice|execFile|spawn\(/;
    for (const file of graderFiles) {
      const code = readFileSync(file, "utf8").replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "");
      expect(code, relative(ROOT, file)).not.toMatch(forbidden);
    }
  });

  it("the walker catches a gate import (bite check)", () => {
    const fake =
      'import { x } from "../../verify/uno-verifier.ts";\nexport * from "../../core/filepersist.ts";\nimport "child_process";';
    expect(specifiers(fake)).toEqual([
      "../../verify/uno-verifier.ts",
      "../../core/filepersist.ts",
      "child_process",
    ]);
  });
});

/**
 * Capability track T (bring your own app): third-party plugins (`src/plugins/`, the example
 * plugins under `examples/plugins/`) never share code with the grader, in either direction.
 * A plugin oracle is a gate-side oracle as far as R1 is concerned: if it shared code with the
 * grader, the grader would grade the plugin with the plugin.
 */
describe("plugins never share code with the benchmark grader (track T)", () => {
  const PLUGIN_ROOTS = [join(ROOT, "src", "plugins"), join(ROOT, "examples", "plugins")];
  const pluginFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? pluginFiles(join(dir, e.name))
        : /\.(ts|mjs|js)$/.test(e.name)
          ? [join(dir, e.name)]
          : [],
    );
  const files = PLUGIN_ROOTS.flatMap(pluginFiles);

  it("has plugin modules to check", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it("no plugin module reaches src/benchmark/grade/ (transitively)", () => {
    const violations: string[] = [];
    for (const file of files)
      for (const mod of walk(file).keys())
        if (mod.startsWith(`${GRADER}/`))
          violations.push(`${relative(ROOT, mod)} reached from ${relative(ROOT, file)}`);
    expect(violations).toEqual([]);
  });

  it("no grader module reaches a plugin module (transitively)", () => {
    for (const file of graderFiles)
      for (const mod of walk(file).keys())
        for (const root of PLUGIN_ROOTS) expect(mod.startsWith(`${root}/`), mod).toBe(false);
  });

  it("no plugin module names the grader", () => {
    for (const file of files)
      expect(readFileSync(file, "utf8"), relative(ROOT, file)).not.toMatch(/benchmark\/grade/);
  });
});
