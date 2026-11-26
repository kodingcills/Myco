/**
 * TIF-267 independence guard: the benchmark grader must not share code with the gating
 * oracle (M2 plan §4: "if it shares code or inputs with the gating oracle, R1 grades
 * itself"). Walks the transitive relative-import graph of every grader module and fails
 * if it leaves `src/benchmark/grade/`, or reaches a process launcher (the gate's persisted
 * check runs `soffice`).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
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

describe("the corrections A/B analysis never reaches gate code (#547 round 1, D7)", () => {
  const AB = join(ROOT, "src", "m2", "corrections-ab.ts");
  const GATE = join(ROOT, "src", "gate");
  const VERIFY = join(ROOT, "src", "verify");
  /** The guard itself: every module the walk reaches under src/gate/ or src/verify/. */
  const gateSide = (entry: string) =>
    [...walk(entry).keys()]
      .filter((m) => m.startsWith(`${GATE}/`) || m.startsWith(`${VERIFY}/`))
      .map((m) => relative(ROOT, m));
  /** Every child_process import the walk reaches. */
  const launchers = (entry: string) =>
    [...walk(entry)].flatMap(([mod, specs]) =>
      specs
        .filter((s) => /child_process/.test(s))
        .map((s) => `${relative(ROOT, mod)} imports ${s}`),
    );

  it("its transitive imports stay out of src/gate/ and src/verify/, and launch no process", () => {
    expect([...walk(AB).keys()]).toContain(join(GRADER, "row.ts"));
    expect(gateSide(AB)).toEqual([]);
    expect(launchers(AB)).toEqual([]);
  });

  it("the check bites: the same walk and predicates report a planted gate, verify or launcher import (#547 R2-D6)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-bite-"));
    try {
      const planted = join(dir, "planted.ts");
      const rel = (p: string) => relative(dir, p).split(sep).join("/");
      writeFileSync(
        planted,
        `import { x } from "${rel(join(GRADER, "row.ts"))}";\n` +
          `import "${rel(join(GATE, "corrections.ts"))}";\n` +
          `import "${rel(join(VERIFY, "uno-verifier.ts"))}";\n` +
          `import "node:child_process";\nexport { x };\n`,
      );
      expect(gateSide(planted)).toEqual(
        expect.arrayContaining(["src/gate/corrections.ts", "src/verify/uno-verifier.ts"]),
      );
      expect(launchers(planted)).toContain(`${relative(ROOT, planted)} imports node:child_process`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
